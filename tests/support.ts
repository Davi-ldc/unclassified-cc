import assert from 'node:assert/strict'
import { once } from 'node:events'
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import type { TestContext } from 'node:test'
import type { Config } from '../src/config.js'
import { createProxyServer } from '../src/proxy.js'

export const CLIENT_TOKEN = 'dummy-client-token'
export const UPSTREAM_KEY = 'dummy-upstream-key'
export const TEST_OPTIONS = { timeout: 8_000 }

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

export function origin(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

export async function listen(t: TestContext, server: Server) {
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
        else resolve()
      })
      server.closeAllConnections()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server
}

export async function mockServer(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
) {
  const errors: unknown[] = []
  const server = createServer((req, res) => {
    req.on('error', () => {})
    void Promise.resolve().then(() => handler(req, res)).catch((error) => {
      errors.push(error)
      res.destroy()
    })
  })
  await listen(t, server)
  t.after(() => assert.deepEqual(errors, [], 'Mock handler failed'))
  return server
}

export function configFor(
  upstreamUrl: string,
  options: {
    server?: Partial<Config['server']>
    tokens?: Config['auth']['tokens']
    apiKey?: string
  } = {},
): Config {
  return {
    server: {
      host: '127.0.0.1',
      port: 0,
      max_body_bytes: 32 * 1024 * 1024,
      request_timeout_ms: 120_000,
      upstream_timeout_ms: 600_000,
      ...options.server,
    },
    upstream: {
      url: upstreamUrl,
      api_key: options.apiKey ?? UPSTREAM_KEY,
      user_agent: 'opencode/1.18.35',
    },
    auth: { tokens: options.tokens ?? [{ name: 'test-client', token: CLIENT_TOKEN }] },
    logging: { level: 'error', audit: false },
  }
}

export async function gateway(
  t: TestContext,
  upstreamUrl: string,
  options: Parameters<typeof configFor>[1] = {},
) {
  const config = configFor(upstreamUrl, options)
  return listen(t, createProxyServer(config, {}))
}

export async function bodyOf(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

export type CallOptions = {
  path?: string
  method?: string
  token?: string | null
  headers?: OutgoingHttpHeaders
  onResponse?: (response: IncomingMessage) => void
}

export type WireResponse = {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
  complete: boolean
}

export function openCall(server: Server, options: CallOptions = {}) {
  let resolve!: (result: WireResponse) => void
  let reject!: (error: unknown) => void
  const finished = new Promise<WireResponse>((yes, no) => {
    resolve = yes
    reject = no
  })
  const headers: OutgoingHttpHeaders = {
    ...(options.token !== null ? { 'x-api-key': options.token ?? CLIENT_TOKEN } : {}),
    ...options.headers,
  }
  const req = request({
    hostname: '127.0.0.1',
    port: (server.address() as AddressInfo).port,
    path: options.path ?? '/v1/messages',
    method: options.method ?? 'POST',
    headers,
    agent: false,
  }, (res) => {
    const chunks: Buffer[] = []
    let done = false
    const finish = (complete: boolean) => {
      if (done) return
      done = true
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
        complete,
      })
    }
    res.on('data', (chunk: Buffer) => chunks.push(chunk))
    res.once('end', () => finish(true))
    res.once('aborted', () => finish(false))
    res.once('error', () => finish(false))
    options.onResponse?.(res)
  })
  req.on('error', reject)
  return { req, finished }
}

export async function call(server: Server, options: CallOptions = {}, body: string | Buffer = '') {
  const exchange = openCall(server, options)
  exchange.req.end(body)
  const response = await exchange.finished
  assert.equal(response.complete, true, 'Response terminated before its body completed')
  return response
}
