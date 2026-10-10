import assert from 'node:assert/strict'
import type { IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { test, type TestContext } from 'node:test'
import { gzipSync } from 'node:zlib'
import type { Config } from '../src/config.js'
import { setLogLevel } from '../src/logger.js'
import { createProxyServer } from '../src/proxy.js'
import { bodyOf, call, configFor, deferred, listen, mockServer, openCall, origin, TEST_OPTIONS, UPSTREAM_KEY } from './support.js'

const FALLBACKS = ['dummy-fallback-one', 'dummy-fallback-two']
const KEYS = [UPSTREAM_KEY, ...FALLBACKS]
const JSON_HEADERS: OutgoingHttpHeaders = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }
const REQUEST = '{"model":"claude-test","max_tokens":9,"messages":[{"role":"user","content":"olá, mundo"}]}'
const BILLING = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'

type Reply = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void | Promise<void>
type Seen = { key: string; body: Buffer; headers: IncomingMessage['headers']; url: string }

const apiError = (type: string, message: string) => ({ type: 'error', error: { type, message } })

function raw(status: number, payload: Buffer | string, headers: Record<string, string> = {}): Reply {
  const bytes = Buffer.from(payload)
  return (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(bytes.length), ...headers })
    res.end(bytes)
  }
}

const json = (status: number, value: unknown, headers: Record<string, string> = {}): Reply =>
  raw(status, JSON.stringify(value), headers)

const ok = json(200, { id: 'msg_ok', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] })
const reset: Reply = (req) => { req.socket.destroy() }

async function upstream(t: TestContext, replies: Record<string, Reply>) {
  const seen: Seen[] = []
  const server = await mockServer(t, async (req, res) => {
    const body = await bodyOf(req)
    const key = String(req.headers['x-api-key'])
    seen.push({ key, body, headers: req.headers, url: req.url! })
    const reply = replies[key]
    assert.ok(reply, 'Unexpected upstream credential')
    await reply(req, res, body)
  })
  return { server, seen, keys: () => seen.map(entry => entry.key) }
}

type PoolOptions = { now?: () => number; server?: Partial<Config['server']> }

async function pooled(t: TestContext, upstreamUrl: string, extras: string[], options: PoolOptions = {}): Promise<Server> {
  const config = configFor(upstreamUrl, { server: options.server })
  config.upstream.fallback_api_keys = extras
  return listen(t, createProxyServer(config, {}, { now: options.now }))
}

async function scenario(t: TestContext, replies: Record<string, Reply>, options: PoolOptions = {}) {
  const mock = await upstream(t, replies)
  const proxy = await pooled(t, origin(mock.server), FALLBACKS, options)
  return { ...mock, proxy }
}

const send = (proxy: Server, body = REQUEST, path = '/v1/messages') => call(proxy, { path, headers: JSON_HEADERS }, body)
const text = (body: Buffer) => JSON.parse(body.toString()).content[0].text
const withoutKey = (headers: IncomingMessage['headers']) => {
  const copy = { ...headers }
  delete copy['x-api-key']
  return copy
}

test('a rate-limited primary falls back with the identical payload and headers', TEST_OPTIONS, async t => {
  const s = await scenario(t, {
    [UPSTREAM_KEY]: json(429, apiError('rate_limit_error', 'slow down'), { 'retry-after': '2' }),
    [FALLBACKS[0]]: ok,
  })
  const response = await send(s.proxy)
  assert.equal(response.status, 200)
  assert.equal(text(response.body), 'ok')
  assert.deepEqual(s.keys(), [UPSTREAM_KEY, FALLBACKS[0]])
  assert.equal(s.seen[0].body.toString(), REQUEST)
  assert.deepEqual(s.seen[1].body, s.seen[0].body)
  assert.deepEqual(withoutKey(s.seen[1].headers), withoutKey(s.seen[0].headers))
  assert.equal(s.seen[1].url, s.seen[0].url)
})

test('an upstream authentication error falls back, other 401 responses are returned unchanged', TEST_OPTIONS, async t => {
  const rejected = await scenario(t, {
    [UPSTREAM_KEY]: json(401, apiError('authentication_error', 'invalid x-api-key')),
    [FALLBACKS[0]]: ok,
  })
  const accepted = await send(rejected.proxy)
  assert.equal(accepted.status, 200)
  assert.deepEqual(rejected.keys(), [UPSTREAM_KEY, FALLBACKS[0]])

  const unrelated = apiError('permission_error', 'not allowed')
  const other = await scenario(t, { [UPSTREAM_KEY]: json(401, unrelated), [FALLBACKS[0]]: ok })
  const response = await send(other.proxy)
  assert.equal(response.status, 401)
  assert.deepEqual(JSON.parse(response.body.toString()), unrelated)
  assert.deepEqual(other.keys(), [UPSTREAM_KEY])
})

test('the exhausted-balance 400 falls back while every other client error is returned unchanged', TEST_OPTIONS, async t => {
  const billing = await scenario(t, {
    [UPSTREAM_KEY]: json(400, apiError('invalid_request_error', BILLING)),
    [FALLBACKS[0]]: ok,
  })
  assert.equal((await send(billing.proxy)).status, 200)
  assert.deepEqual(billing.keys(), [UPSTREAM_KEY, FALLBACKS[0]])

  const unchanged: Array<[number, Buffer | string, string]> = [
    [400, JSON.stringify(apiError('invalid_request_error', 'max_tokens: required')), 'application/json'],
    [400, JSON.stringify(apiError('api_error', BILLING)), 'application/json'],
    [400, 'bad request', 'text/plain'],
    [403, JSON.stringify(apiError('permission_error', 'forbidden')), 'application/json'],
    [404, JSON.stringify(apiError('not_found_error', 'model not found')), 'application/json'],
    [413, JSON.stringify(apiError('request_too_large', 'too large')), 'application/json'],
    [529, JSON.stringify(apiError('overloaded_error', 'overloaded')), 'application/json'],
  ]
  for (const [status, payload, type] of unchanged) {
    const s = await scenario(t, { [UPSTREAM_KEY]: raw(status, payload, { 'content-type': type }), [FALLBACKS[0]]: ok })
    const response = await send(s.proxy)
    assert.equal(response.status, status, `${status} ${type}`)
    assert.deepEqual(response.body, Buffer.from(payload), `${status} ${type}`)
    assert.equal(response.headers['content-type'], type)
    assert.deepEqual(s.keys(), [UPSTREAM_KEY], `${status} ${type}`)
  }
})

test('server failures 500, 502, 503 and 504 fall back', TEST_OPTIONS, async t => {
  for (const status of [500, 502, 503, 504]) {
    const s = await scenario(t, { [UPSTREAM_KEY]: json(status, apiError('api_error', 'boom')), [FALLBACKS[0]]: ok })
    const response = await send(s.proxy)
    assert.equal(response.status, 200, String(status))
    assert.deepEqual(s.keys(), [UPSTREAM_KEY, FALLBACKS[0]], String(status))
  }
})

test('a refusal is a successful response and is never retried', TEST_OPTIONS, async t => {
  const refusal = { id: 'msg_refusal', type: 'message', role: 'assistant', content: [], stop_reason: 'refusal' }
  const s = await scenario(t, { [UPSTREAM_KEY]: json(200, refusal), [FALLBACKS[0]]: ok })
  const response = await send(s.proxy)
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body.toString()), refusal)
  assert.deepEqual(s.keys(), [UPSTREAM_KEY])
})

test('a mixed failure sequence tries each key once and later requests skip the cooling keys', TEST_OPTIONS, async t => {
  const time = { now: 1_700_000_000_000 }
  const s = await scenario(t, {
    [UPSTREAM_KEY]: json(500, apiError('api_error', 'boom')),
    [FALLBACKS[0]]: json(429, apiError('rate_limit_error', 'slow down')),
    [FALLBACKS[1]]: ok,
  }, { now: () => time.now })
  assert.equal((await send(s.proxy)).status, 200)
  assert.deepEqual(s.keys(), KEYS)
  assert.equal((await send(s.proxy)).status, 200)
  assert.deepEqual(s.keys(), [...KEYS, FALLBACKS[1]])
})

test('when every key fails the last upstream response is returned unchanged and the pool then cools down', TEST_OPTIONS, async t => {
  const time = { now: 1_700_000_000_000 }
  const last = apiError('rate_limit_error', 'the last key is limited')
  const s = await scenario(t, {
    [UPSTREAM_KEY]: json(429, apiError('rate_limit_error', 'first'), { 'retry-after': '1' }),
    [FALLBACKS[0]]: json(500, apiError('api_error', 'second')),
    [FALLBACKS[1]]: json(429, last, { 'retry-after': '7', 'request-id': 'req-last' }),
  }, { now: () => time.now })
  const response = await send(s.proxy)
  assert.equal(response.status, 429)
  assert.deepEqual(JSON.parse(response.body.toString()), last)
  assert.equal(response.headers['retry-after'], '7')
  assert.equal(response.headers['request-id'], 'req-last')
  assert.deepEqual(s.keys(), KEYS)

  // Every key is cooling: answer locally and leave the upstream alone.
  const cooling = await send(s.proxy)
  assert.equal(cooling.status, 503)
  assert.equal(cooling.headers['retry-after'], '5')
  assert.equal(JSON.parse(cooling.body.toString()).error.type, 'api_error')
  assert.deepEqual(s.keys(), KEYS)
  for (const key of KEYS) assert.ok(!cooling.body.includes(key))
})

test('a failed key is skipped until its cooldown ends and then becomes the first choice again', TEST_OPTIONS, async t => {
  const time = { now: 1_700_000_000_000 }
  const replies: Record<string, Reply> = {
    [UPSTREAM_KEY]: json(429, apiError('rate_limit_error', 'slow down')),
    [FALLBACKS[0]]: ok,
  }
  const s = await scenario(t, replies, { now: () => time.now })
  assert.equal((await send(s.proxy)).status, 200)
  assert.deepEqual(s.keys(), [UPSTREAM_KEY, FALLBACKS[0]])
  assert.equal((await send(s.proxy)).status, 200)
  assert.deepEqual(s.keys().slice(2), [FALLBACKS[0]])

  replies[UPSTREAM_KEY] = ok
  time.now += 29_999
  assert.equal((await send(s.proxy)).status, 200)
  assert.deepEqual(s.keys().slice(3), [FALLBACKS[0]])
  time.now += 1
  assert.equal((await send(s.proxy)).status, 200)
  assert.deepEqual(s.keys().slice(4), [UPSTREAM_KEY])
})

test('Retry-After extends a cooldown and is bounded', TEST_OPTIONS, async t => {
  for (const [header, cooldown] of [['120', 120_000], ['999999', 300_000]] as const) {
    const time = { now: 1_700_000_000_000 }
    const replies: Record<string, Reply> = {
      [UPSTREAM_KEY]: json(429, apiError('rate_limit_error', 'slow down'), { 'retry-after': header }),
      [FALLBACKS[0]]: ok,
    }
    const s = await scenario(t, replies, { now: () => time.now })
    await send(s.proxy)
    replies[UPSTREAM_KEY] = ok
    time.now += cooldown - 1
    await send(s.proxy)
    assert.equal(s.keys().at(-1), FALLBACKS[0], header)
    time.now += 1
    await send(s.proxy)
    assert.equal(s.keys().at(-1), UPSTREAM_KEY, header)
  }
})

test('a connection reset before the response falls back, and a total outage yields a controlled 502', TEST_OPTIONS, async t => {
  const recovered = await scenario(t, { [UPSTREAM_KEY]: reset, [FALLBACKS[0]]: ok })
  assert.equal((await send(recovered.proxy)).status, 200)
  assert.deepEqual(recovered.keys(), [UPSTREAM_KEY, FALLBACKS[0]])

  const outage = await scenario(t, { [UPSTREAM_KEY]: reset, [FALLBACKS[0]]: reset, [FALLBACKS[1]]: reset })
  const response = await send(outage.proxy)
  assert.equal(response.status, 502)
  assert.equal(JSON.parse(response.body.toString()).error.message, 'Upstream request failed')
  assert.deepEqual(outage.keys(), KEYS)
})

test('a failure after the response has started is passed through and never retried', TEST_OPTIONS, async t => {
  const release = deferred()
  const firstChunk = deferred()
  t.after(() => release.resolve())
  const initial = Buffer.from('event: ping\ndata: {"type":"ping"}\n\n')
  const s = await scenario(t, {
    [UPSTREAM_KEY]: async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(initial)
      await release.promise
      res.destroy()
    },
    [FALLBACKS[0]]: ok,
  })
  const exchange = openCall(s.proxy, {
    headers: JSON_HEADERS,
    onResponse: response => response.once('data', () => firstChunk.resolve()),
  })
  exchange.req.end(REQUEST)
  await firstChunk.promise
  release.resolve()
  const response = await exchange.finished
  assert.equal(response.status, 200)
  assert.equal(response.complete, false)
  assert.deepEqual(response.body, initial)
  assert.deepEqual(s.keys(), [UPSTREAM_KEY])
})

test('a client that disconnects cancels the attempt and no later key is contacted', TEST_OPTIONS, async t => {
  const reached = deferred()
  const closed = deferred()
  const s = await scenario(t, {
    [UPSTREAM_KEY]: (_req, res) => {
      res.once('close', () => closed.resolve())
      reached.resolve()
    },
    [FALLBACKS[0]]: ok,
  })
  const exchange = openCall(s.proxy, { headers: JSON_HEADERS })
  const finished = exchange.finished.catch(() => undefined)
  exchange.req.end(REQUEST)
  await reached.promise
  exchange.req.destroy()
  await finished
  await closed.promise
  await sleep(150)
  assert.deepEqual(s.keys(), [UPSTREAM_KEY])
})

test('compressed error bodies are inspected within bounds', TEST_OPTIONS, async t => {
  const packed = gzipSync(Buffer.from(JSON.stringify(apiError('invalid_request_error', BILLING))))
  const billing = await scenario(t, {
    [UPSTREAM_KEY]: raw(400, packed, { 'content-encoding': 'gzip' }),
    [FALLBACKS[0]]: ok,
  })
  assert.equal((await send(billing.proxy)).status, 200)
  assert.deepEqual(billing.keys(), [UPSTREAM_KEY, FALLBACKS[0]])

  // Expands far beyond the inspection limit: returned byte for byte, without falling back.
  const bomb = gzipSync(Buffer.alloc(200_000, 0x61))
  const bounded = await scenario(t, {
    [UPSTREAM_KEY]: raw(400, bomb, { 'content-encoding': 'gzip' }),
    [FALLBACKS[0]]: ok,
  })
  const response = await send(bounded.proxy)
  assert.equal(response.status, 400)
  assert.equal(response.headers['content-encoding'], 'gzip')
  assert.deepEqual(response.body, bomb)
  assert.deepEqual(bounded.keys(), [UPSTREAM_KEY])
})

test('oversized error bodies are returned complete whether or not their length is declared', TEST_OPTIONS, async t => {
  const padding = 'x'.repeat(40_000)
  const payload = Buffer.from(JSON.stringify(apiError('invalid_request_error', `${BILLING} ${padding}`)))
  for (const declared of [true, false]) {
    const reply: Reply = declared
      ? raw(400, payload)
      : (_req, res) => {
        res.writeHead(400, { 'content-type': 'application/json' })
        for (let offset = 0; offset < payload.length; offset += 7_000) res.write(payload.subarray(offset, offset + 7_000))
        res.end()
      }
    const s = await scenario(t, { [UPSTREAM_KEY]: reply, [FALLBACKS[0]]: ok })
    const response = await send(s.proxy)
    assert.equal(response.status, 400, String(declared))
    assert.deepEqual(response.body, payload, String(declared))
    assert.deepEqual(s.keys(), [UPSTREAM_KEY], String(declared))
  }
})

test('every attempt reuses the translated payload and the response codec restores tool calls', TEST_OPTIONS, async t => {
  const request = JSON.stringify({
    model: 'claude-test',
    max_tokens: 16,
    tools: [{
      name: 'Read',
      description: 'Read a file.',
      input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
    }],
    messages: [{ role: 'user', content: 'read it' }],
  })
  const toolUse = json(200, {
    id: 'msg_tool', type: 'message', role: 'assistant', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: '/tmp/file' } }],
  })
  const s = await scenario(t, { [UPSTREAM_KEY]: json(503, apiError('api_error', 'overloaded')), [FALLBACKS[0]]: toolUse })
  const response = await send(s.proxy, request, '/agent-v2/v1/messages')
  assert.equal(response.status, 200)
  const message = JSON.parse(response.body.toString())
  assert.equal(message.content[0].name, 'Read')
  assert.deepEqual(message.content[0].input, { file_path: '/tmp/file' })
  assert.deepEqual(s.keys(), [UPSTREAM_KEY, FALLBACKS[0]])
  assert.deepEqual(s.seen[1].body, s.seen[0].body)
  assert.equal(s.seen[0].url, '/v1/messages')
  const wire = JSON.parse(s.seen[0].body.toString())
  assert.equal(wire.tools[0].name, 'read_file')
  assert.ok(Object.hasOwn(wire.tools[0].input_schema.properties, 'path'))
})

test('without additional keys a failing key is never cooled or skipped', TEST_OPTIONS, async t => {
  const mock = await upstream(t, { [UPSTREAM_KEY]: json(429, apiError('rate_limit_error', 'slow down'), { 'retry-after': '9' }) })
  const proxy = await listen(t, createProxyServer(configFor(origin(mock.server)), {}))
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await send(proxy)
    assert.equal(response.status, 429)
    assert.equal(response.headers['retry-after'], '9')
    assert.equal(mock.keys().length, attempt)
  }
  const rejected = apiError('authentication_error', 'invalid x-api-key')
  const other = await upstream(t, { [UPSTREAM_KEY]: json(401, rejected) })
  const single = await listen(t, createProxyServer(configFor(origin(other.server)), {}))
  const response = await send(single)
  assert.equal(response.status, 401)
  assert.deepEqual(JSON.parse(response.body.toString()), rejected)
})

test('failover diagnostics identify positions and never credentials', TEST_OPTIONS, async t => {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  t.after(() => { console.log = original; setLogLevel('info') })
  setLogLevel('warn')
  const s = await scenario(t, {
    [UPSTREAM_KEY]: json(429, apiError('rate_limit_error', 'slow down')),
    [FALLBACKS[0]]: json(500, apiError('api_error', 'boom')),
    [FALLBACKS[1]]: ok,
  })
  const response = await send(s.proxy)
  console.log = original
  assert.equal(response.status, 200)
  const output = lines.join('\n')
  assert.match(output, /credential 1 unavailable \(rate_limit\); trying credential 2/)
  assert.match(output, /credential 2 unavailable \(transient\); trying credential 3/)
  for (const key of KEYS) {
    assert.ok(!output.includes(key))
    assert.ok(!response.body.includes(key))
  }
})
