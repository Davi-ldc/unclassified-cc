import { createServer as createHttpsServer, request as httpsRequest } from 'https'
import {
  createServer as createHttpServer,
  request as httpRequest,
  type Agent,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'http'
import { readFileSync } from 'fs'
import type { Config } from './config.js'
import { createAuthenticator } from './auth.js'
import { buildUpstreamHeaders } from './headers.js'
import { BodyError, prepareNeutralRequest, rewriteRequestBody } from './body.js'
import { WireProfileError, type WireCodec } from './wire-profile.js'
import { createResponseTransform } from './response.js'
import { pipeline, type Transform } from 'stream'
import { createBrotliDecompress, createGunzip, createInflate, createZstdDecompress, brotliDecompress, gunzip, inflate, zstdDecompress } from 'zlib'
import { promisify } from 'util'
import { KeyPool, keyFailure, type KeyFailure } from './key-pool.js'
import { audit, log } from './logger.js'
import { createUpstreamAgent } from './proxy-agent.js'

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.destroyed) return
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...(status >= 400 ? { connection: 'close' } : {}),
  })
  res.end(JSON.stringify(body))
}

function requestTarget(req: IncomingMessage): { path: string; pathname: string } {
  const path = req.url || '/'
  if (!path.startsWith('/') || path.startsWith('//') || /[\\#\s\x00-\x1f\x7f]/.test(path)) {
    throw new RequestError(400, 'An origin-form request target is required')
  }
  return { path, pathname: path.split('?', 1)[0] }
}

function readBody(req: IncomingMessage, maxBytes: number, timeout: number): Promise<Buffer> {
  const length = req.headers['content-length']
  if (length !== undefined && Number(length) > maxBytes) {
    throw new RequestError(413, 'Request body is too large')
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const timer = setTimeout(() => fail(408, 'Request body timed out'), timeout)
    const cleanup = () => {
      clearTimeout(timer)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('aborted', onAborted)
      req.off('error', onError)
    }
    const fail = (status: number, message: string) => {
      if (settled) return
      settled = true
      cleanup()
      chunks.length = 0
      req.pause()
      reject(new RequestError(status, message))
    }
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        fail(413, 'Request body is too large')
      } else {
        chunks.push(chunk)
      }
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(Buffer.concat(chunks, size))
    }
    const onAborted = () => fail(400, 'Request body was interrupted')
    const onError = () => fail(400, 'Could not read request body')
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('aborted', onAborted)
    req.once('error', onError)
  })
}

function responseHeaders(incoming: IncomingMessage) {
  const headers = { ...incoming.headers }
  const hopByHop = [
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade',
    ...(incoming.headers.connection || '').toLowerCase().split(',').map((name) => name.trim()),
  ]
  for (const name of hopByHop) delete headers[name]
  return headers
}

const ERROR_PROBE_BYTES = 16 * 1024
const errorDecoders = {
  gzip: promisify(gunzip),
  deflate: promisify(inflate),
  br: promisify(brotliDecompress),
  zstd: promisify(zstdDecompress),
}

async function decodeError(body: Buffer, contentEncoding: string | undefined): Promise<Buffer | undefined> {
  try {
    const encodings = (contentEncoding ?? 'identity').toLowerCase().split(',').map(value => value.trim())
    if (encodings.length > 4) return undefined
    for (const encoding of encodings.reverse()) {
      if (encoding === 'identity') continue
      if (!Object.hasOwn(errorDecoders, encoding)) return undefined
      body = await errorDecoders[encoding as keyof typeof errorDecoders](body, { maxOutputLength: ERROR_PROBE_BYTES })
    }
    return body
  } catch {
    return undefined
  }
}

// Probe at most one small error envelope. Oversized bodies resume as the original byte stream.
function inspectError(incoming: IncomingMessage, done: (body?: Buffer) => void): () => void {
  const chunks: Buffer[] = []
  let size = 0
  const cleanup = () => {
    incoming.off('readable', onReadable)
    incoming.off('end', onEnd)
  }
  const onReadable = () => {
    while (incoming.readableLength > 0) {
      const chunk = incoming.read(Math.min(incoming.readableLength, ERROR_PROBE_BYTES + 1 - size)) as Buffer | null
      if (!chunk) break
      chunks.push(chunk)
      size += chunk.length
      if (size > ERROR_PROBE_BYTES) {
        cleanup()
        incoming.unshift(Buffer.concat(chunks, size))
        done()
        return
      }
    }
    incoming.read(0)
  }
  const onEnd = () => {
    cleanup()
    done(Buffer.concat(chunks, size))
  }
  incoming.on('readable', onReadable)
  incoming.once('end', onEnd)
  return cleanup
}

function forward(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  upstream: URL,
  agent: Agent,
  path: string,
  body: Buffer,
  keys: readonly string[],
  pool: KeyPool,
  codec?: WireCodec,
) {
  let attemptHeaders: Record<string, string>[]
  try {
    attemptHeaders = keys.map(api_key => buildUpstreamHeaders(req.headersDistinct, { ...config.upstream, api_key }, body.length))
  } catch {
    throw new RequestError(400, 'Invalid request headers')
  }
  const candidates = pool.candidates()
  if (candidates.length === 0) {
    res.setHeader('retry-after', String(pool.retryAfter()))
    sendJson(res, 503, { error: { type: 'api_error', message: 'Upstream credentials are temporarily unavailable' } })
    return
  }

  let proxyReq: ClientRequest | undefined
  let proxyRes: IncomingMessage | undefined
  let cancelInspection: (() => void) | undefined
  const responseStages: Transform[] = []
  let settled = false
  let attempt = 0
  let cursor = 0
  // Every attempt shares the same pre-response budget. Streaming retains its idle timeout.
  const deadline = Date.now() + config.server.upstream_timeout_ms
  const timer = setTimeout(() => fail(504, 'Upstream timed out'), config.server.upstream_timeout_ms)
  const cleanup = () => {
    clearTimeout(timer)
    cancelInspection?.()
    req.off('aborted', onAbort)
    res.off('close', onClose)
    res.off('finish', onFinish)
  }
  const destroyUpstream = () => {
    cancelInspection?.()
    cancelInspection = undefined
    for (const stage of responseStages) stage.destroy()
    proxyRes?.destroy()
    proxyReq?.destroy()
    proxyRes = undefined
    proxyReq = undefined
  }
  const fail = (status: number, message: string) => {
    if (settled) return
    settled = true
    cleanup()
    destroyUpstream()
    log('warn', message)
    sendJson(res, status, { error: { type: 'api_error', message } })
  }
  const onAbort = () => {
    if (settled) return
    settled = true
    cleanup()
    destroyUpstream()
    res.destroy()
  }
  const onClose = () => {
    if (!res.writableFinished) onAbort()
  }
  const onFinish = () => {
    settled = true
    cleanup()
  }
  req.once('aborted', onAbort)
  res.once('close', onClose)
  res.once('finish', onFinish)

  const nextCandidate = (): number | undefined => {
    while (cursor < candidates.length) {
      const index = candidates[cursor++]
      if (pool.available(index)) return index
    }
    return undefined
  }

  const expose = (incoming: IncomingMessage, buffered?: Buffer) => {
    clearTimeout(timer)
    cancelInspection?.()
    cancelInspection = undefined
    // A fully buffered response has already released its socket, so only a stream needs a new idle timer.
    if (buffered === undefined) incoming.setTimeout(config.server.upstream_timeout_ms)
    const headers = responseHeaders(incoming)
    const contentType = incoming.headers['content-type']?.split(';', 1)[0].trim().toLowerCase()
    const mode = contentType === 'text/event-stream' ? 'sse' : contentType === 'application/json' ? 'json' : undefined
    if (codec?.active && mode && (incoming.statusCode ?? 502) < 300) {
      try {
        const encodings = (incoming.headers['content-encoding'] ?? 'identity').toLowerCase().split(',').map(value => value.trim())
        if (encodings.length > 4) throw new Error('Too many content encodings')
        for (const encoding of encodings.reverse()) {
          switch (encoding) {
            case 'identity': break
            case 'gzip': responseStages.push(createGunzip()); break
            case 'deflate': responseStages.push(createInflate()); break
            case 'br': responseStages.push(createBrotliDecompress()); break
            case 'zstd': responseStages.push(createZstdDecompress()); break
            default: throw new Error('Unsupported upstream content encoding')
          }
        }
        responseStages.push(createResponseTransform(codec, mode, config.server.max_body_bytes))
        for (const name of ['content-length', 'content-encoding', 'content-md5', 'digest', 'content-digest', 'repr-digest', 'etag']) delete headers[name]
        for (const stage of responseStages) stage.once('error', () => fail(502, 'Invalid upstream tool response'))
        res.writeHead(incoming.statusCode || 502, headers)
        res.flushHeaders()
        pipeline([incoming, ...responseStages, res], error => {
          if (error) fail(502, 'Upstream response translation failed')
        })
      } catch {
        fail(502, 'Unsupported upstream response')
      }
    } else {
      res.writeHead(incoming.statusCode || 502, headers)
      res.flushHeaders()
      if (buffered !== undefined) res.end(buffered)
      else incoming.pipe(res)
    }
  }

  const dispatchAttempt = (index: number) => {
    if (settled || req.aborted || res.destroyed) {
      onAbort()
      return
    }
    if (Date.now() >= deadline) {
      fail(504, 'Upstream timed out')
      return
    }
    const id = ++attempt
    const active = () => !settled && id === attempt
    const retry = (reason: KeyFailure, retryAfter?: string): boolean => {
      if (!active() || res.headersSent || req.aborted || res.destroyed) return false
      pool.defer(index, reason, retryAfter)
      const next = nextCandidate()
      if (next === undefined || Date.now() >= deadline) return false
      // Only positions appear in logs; credentials never do.
      log('warn', `Upstream credential ${index + 1} unavailable (${reason}); trying credential ${next + 1}`)
      // Retired sockets may emit errors while the next attempt is already in flight.
      ++attempt
      destroyUpstream()
      dispatchAttempt(next)
      return true
    }
    const networkFailure = (status: number, message: string) => {
      if (!active()) return
      if (req.aborted || res.destroyed) { onAbort(); return }
      if (!res.headersSent && retry('transient')) return
      fail(status, message)
    }
    try {
      const request = upstream.protocol === 'https:' ? httpsRequest : httpRequest
      // The URL owns the destination; the origin-form path is never resolved as a URL.
      proxyReq = request(upstream, {
        method: req.method,
        path,
        agent,
        headers: { ...attemptHeaders[index], host: upstream.host },
      }, (incoming) => {
        if (!active()) { incoming.destroy(); return }
        proxyRes = incoming
        incoming.setTimeout(config.server.upstream_timeout_ms, () => {
          if (active()) networkFailure(504, 'Upstream timed out')
        })
        incoming.once('aborted', () => networkFailure(502, 'Upstream response was interrupted'))
        incoming.once('error', () => networkFailure(502, 'Upstream response failed'))
        const status = incoming.statusCode ?? 502
        const retryAfter = incoming.headers['retry-after']
        const reason = keyFailure(status)
        if (reason && retry(reason, retryAfter)) return
        if (keys.length > 1 && (status === 400 || status === 401)
          && !(Number(incoming.headers['content-length']) > ERROR_PROBE_BYTES)) {
          cancelInspection = inspectError(incoming, buffered => {
            void (async () => {
              const decoded = buffered === undefined ? undefined : await decodeError(buffered, incoming.headers['content-encoding'])
              if (!active()) return
              if (req.aborted || res.destroyed) { onAbort(); return }
              const reason = keyFailure(status, decoded)
              if (reason && retry(reason, retryAfter)) return
              expose(incoming, buffered)
            })().catch(() => { if (active()) fail(502, 'Upstream response failed') })
          })
        } else {
          expose(incoming)
        }
      })
      proxyReq.once('error', () => networkFailure(502, 'Upstream request failed'))
      proxyReq.end(body)
    } catch {
      networkFailure(502, 'Upstream request failed')
    }
  }
  dispatchAttempt(nextCandidate()!)
}

export type ProxyOptions = {
  /** Clock for credential cooldowns; tests inject one to avoid real waiting. */
  now?: () => number
}

export function createProxyServer(config: Config, env: NodeJS.ProcessEnv = process.env, options: ProxyOptions = {}) {
  const upstream = new URL(config.upstream.url)
  const authenticate = createAuthenticator(config.auth.tokens)
  // Order is the failover order: the primary key first, then each additional key.
  const keys = [config.upstream.api_key, ...(config.upstream.fallback_api_keys ?? [])]
  if (new Set(keys).size !== keys.length) throw new Error('Upstream API keys must be unique')
  for (const api_key of keys) buildUpstreamHeaders({}, { ...config.upstream, api_key }, 0)
  // The pool belongs to this server instance and holds deadlines by index, never credentials.
  const pool = new KeyPool(keys.length, options.now)
  const agent = createUpstreamAgent(upstream, env)

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const target = requestTarget(req)
    const prefix = target.pathname === '/agent-v2' || target.pathname.startsWith('/agent-v2/') ? '/agent-v2'
      : target.pathname === '/agent' || target.pathname.startsWith('/agent/') ? '/agent' : undefined
    const neutral = prefix !== undefined
    const profile = prefix === '/agent-v2' ? 'neutral-v2' : 'neutral-v1'
    const path = prefix ? target.path.slice(prefix.length) || '/' : target.path
    const pathname = path.split('?', 1)[0]
    if (!path.startsWith('/') || path.startsWith('//')) throw new RequestError(400, 'Invalid API route')
    const method = req.method || 'GET'
    if (pathname === '/_health') {
      if (method !== 'GET' && method !== 'HEAD') throw new RequestError(405, 'Use GET for health checks')
      sendJson(res, 200, { status: 'ok' })
      return
    }

    const client = authenticate(req)
    if (!client) {
      sendJson(res, 401, { error: { type: 'authentication_error', message: 'Invalid gateway credential' } })
      return
    }
    if (pathname === '/_verify') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { error: { type: 'invalid_request_error', message: 'Use GET for verification' } })
        return
      }
      const headers = buildUpstreamHeaders({}, config.upstream, 0)
      headers['x-api-key'] = '[redacted]'
      sendJson(res, 200, { profile: neutral ? profile : 'opencode-private', headers, body: { remove: 'metadata.user_id', context_attribution: neutral ? 'neutral' : 'CC' } })
      return
    }
    if (!pathname.startsWith('/v1/')) {
      sendJson(res, 404, { error: { type: 'not_found_error', message: 'Unknown API route' } })
      return
    }
    if (config.logging.audit) {
      res.once('finish', () => audit(client, method, '/v1/*', res.statusCode))
    }

    const original = await readBody(req, config.server.max_body_bytes, config.server.request_timeout_ms)
    const prepared = neutral
      ? await prepareNeutralRequest(original, pathname, req.headers['content-encoding'], config.server.max_body_bytes, profile)
      : { body: await rewriteRequestBody(original, pathname, req.headers['content-encoding'], config.server.max_body_bytes), codec: undefined }
    if (res.destroyed || req.aborted) return
    forward(req, res, config, upstream, agent, path, prepared.body, keys, pool, prepared.codec)
  }
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    // An unread or aborted request can report a socket error after an early response.
    req.on('error', () => {})
    res.on('error', () => res.destroy())
    void handle(req, res).catch((error: unknown) => {
      const expected = error instanceof RequestError || error instanceof BodyError || error instanceof WireProfileError
      const status = expected ? error.status : 500
      const message = expected ? error.message : 'Gateway request failed'
      sendJson(res, status, { error: { type: status >= 500 ? 'api_error' : 'invalid_request_error', message } })
    })
  }

  const tls = config.server.tls
  const server = tls
    ? createHttpsServer({ cert: readFileSync(tls.cert), key: readFileSync(tls.key) }, handler)
    : createHttpServer(handler)
  server.requestTimeout = config.server.request_timeout_ms
  server.headersTimeout = Math.min(60_000, config.server.request_timeout_ms)
  server.on('close', () => agent.destroy())
  return server
}

export function startProxy(config: Config) {
  const server = createProxyServer(config)
  server.listen(config.server.port, config.server.host, () => {
    const protocol = config.server.tls ? 'https' : 'http'
    log('info', `CC Gateway listening on ${protocol}://${config.server.host}:${config.server.port}`)
  })
  return server
}
