import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import type { IncomingHttpHeaders } from 'node:http'
import {
  bodyOf,
  call,
  CLIENT_TOKEN,
  deferred,
  gateway,
  mockServer,
  openCall,
  origin,
  TEST_OPTIONS,
  UPSTREAM_KEY,
} from './support.js'

const forbiddenHeaders = [
  'authorization', 'proxy-authorization', 'x-app', 'anthropic-beta',
  'x-claude-code-session-id', 'x-claude-code-agent-id', 'x-anthropic-billing-header',
  'x-opencode-session-id', 'x-session-affinity', 'x-session-id',
  'x-stainless-runtime', 'x-stainless-os', 'x-forwarded-for', 'traceparent',
  'baggage', 'x-custom-tracker', 'x-client-request-id',
]

test('the wire carries only gateway-owned identity and credentials', TEST_OPTIONS, async (t) => {
  const captured = deferred<{ headers: IncomingHttpHeaders; body: Buffer; url: string }>()
  const upstream = await mockServer(t, async (req, res) => {
    captured.resolve({ headers: req.headers, body: await bodyOf(req), url: req.url! })
    res.end('accepted')
  })
  const proxy = await gateway(t, origin(upstream))
  const payload = Buffer.from(`{\n  "system": [{"type":"text","text":"Working directory: /home/real/project\\n<system-reminder>Platform: linux</system-reminder>","cache_control":{"type":"ephemeral"}}],\n  "messages": [{"role":"assistant","content":[{"type":"thinking","thinking":"opaque","signature":"signed-value"},{"type":"tool_use","id":"tool_1","name":"Read","input":{"file_path":"/home/real/project/file.ts"}}]}],\n  "metadata":{"user_id":"session-is-body-content"}, "future_field": {"unchanged": true}\n}`)
  const result = await call(proxy, {
    path: '/v1/messages?beta=true&literal=%2Fhome%2Freal%2Fproject',
    headers: {
      Host: 'untrusted.invalid',
      Authorization: `Bearer ${CLIENT_TOKEN}`,
      'Proxy-Authorization': `Bearer ${CLIENT_TOKEN}`,
      'User-Agent': 'claude-cli/2.1.296 (external, cli)',
      'X-App': 'cli',
      'Anthropic-Beta': ['context-management-2025-06-27', 'fast-mode-2026-02-01'],
      'X-Claude-Code-Session-Id': 'claude-session',
      'X-Claude-Code-Agent-Id': 'claude-agent',
      'X-Anthropic-Billing-Header': 'billing-fingerprint',
      'X-OpenCode-Session-Id': 'opencode-session',
      'X-Session-Affinity': 'affinity',
      'X-Session-Id': 'session',
      'X-Stainless-Runtime': 'node',
      'X-Stainless-Os': 'linux',
      'X-Forwarded-For': '192.0.2.1',
      Traceparent: 'private-trace',
      Baggage: 'private-baggage',
      'X-Custom-Tracker': 'private-tracker',
      'X-Client-Request-Id': 'private-request',
      'Anthropic-Version': '2023-06-01',
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'Accept-Encoding': 'gzip',
    },
  }, payload)
  assert.equal(result.status, 200)
  const wire = await captured.promise
  assert.equal(wire.headers['user-agent'], 'opencode/1.18.35')
  assert.doesNotMatch(wire.headers['user-agent']!, /claude|external|cli/i)
  assert.equal(wire.headers['x-api-key'], UPSTREAM_KEY)
  assert.notEqual(wire.headers['x-api-key'], CLIENT_TOKEN)
  assert.equal(wire.headers.host, new URL(origin(upstream)).host)
  assert.equal(wire.headers['anthropic-version'], '2023-06-01')
  assert.equal(wire.headers['content-type'], 'application/json')
  assert.equal(wire.headers.accept, 'text/event-stream')
  assert.equal(wire.headers['accept-encoding'], 'gzip')
  assert.equal(wire.headers['content-length'], String(wire.body.length))
  for (const name of forbiddenHeaders) assert.equal(wire.headers[name], undefined, name)
  const expected = JSON.parse(payload.toString())
  delete expected.metadata
  assert.deepEqual(JSON.parse(wire.body.toString()), expected)
  assert.equal(wire.url, '/v1/messages?beta=true&literal=%2Fhome%2Freal%2Fproject')
})

test('a missing incoming User-Agent still receives the privacy identity', TEST_OPTIONS, async (t) => {
  let headers: IncomingHttpHeaders = {}
  const upstream = await mockServer(t, async (req, res) => {
    headers = req.headers
    await bodyOf(req)
    res.end()
  })
  const proxy = await gateway(t, origin(upstream))
  await call(proxy, { path: '/v1/messages/count_tokens', headers: { 'content-type': 'application/json' } }, '{}')
  assert.equal(headers['user-agent'], 'opencode/1.18.35')
  assert.equal(headers['anthropic-version'], '2023-06-01')
})

test('compressed request and response bodies retain their exact bytes and encodings', TEST_OPTIONS, async (t) => {
  const input = gzipSync(Buffer.from('{ "messages": [{"role":"user","content":"hello"}] }'))
  const output = gzipSync(Buffer.from('{"text":"olá"}'))
  const captured = deferred<{ body: Buffer; encoding: string | undefined }>()
  const upstream = await mockServer(t, async (req, res) => {
    captured.resolve({ body: await bodyOf(req), encoding: req.headers['content-encoding'] })
    res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(output.length) })
    res.end(output)
  })
  const proxy = await gateway(t, origin(upstream))
  const response = await call(proxy, {
    headers: { 'content-encoding': 'gzip', 'content-type': 'application/json', 'accept-encoding': 'gzip' },
  }, input)
  assert.deepEqual((await captured.promise).body, input)
  assert.equal((await captured.promise).encoding, 'gzip')
  assert.deepEqual(response.body, output)
  assert.equal(response.headers['content-encoding'], 'gzip')
  assert.equal(response.headers['content-length'], String(output.length))
})

test('ambiguous protocol headers and duplicate credentials never reach upstream', TEST_OPTIONS, async (t) => {
  let requests = 0
  const upstream = await mockServer(t, (req, res) => { requests++; req.resume(); res.end() })
  const proxy = await gateway(t, origin(upstream))
  for (const headers of [
    { 'anthropic-version': ['2023-06-01', '2023-06-01'] },
    { 'Content-Type': ['application/json', 'text/plain'] },
    { 'anthropic-version': '2023-99-99' },
  ]) {
    const response = await call(proxy, { headers }, '{}')
    assert.equal(response.status, 400)
  }
  const duplicate = await call(proxy, { headers: { 'x-api-key': [CLIENT_TOKEN, CLIENT_TOKEN] } }, '{}')
  assert.equal(duplicate.status, 401)
  const conflicting = await call(proxy, { headers: { authorization: 'Bearer another-client-token' } }, '{}')
  assert.equal(conflicting.status, 401)
  for (const token of [null, 'unrecognized-client-token', UPSTREAM_KEY]) {
    const denied = await call(proxy, { token }, '{}')
    assert.equal(denied.status, 401)
  }
  assert.equal(requests, 0)
})

test('health and verification expose no credentials or client roster', TEST_OPTIONS, async (t) => {
  let requests = 0
  const upstream = await mockServer(t, (req, res) => { requests++; req.resume(); res.end() })
  const proxy = await gateway(t, origin(upstream))
  const health = await call(proxy, { path: '/_health', method: 'GET', token: null })
  assert.equal(health.status, 200)
  assert.deepEqual(JSON.parse(health.body.toString()), { status: 'ok' })
  const wrongMethod = await call(proxy, { path: '/_health', token: null })
  assert.equal(wrongMethod.status, 405)
  assert.equal(JSON.parse(wrongMethod.body.toString()).error.type, 'invalid_request_error')
  const denied = await call(proxy, { path: '/_verify', method: 'GET', token: null })
  assert.equal(denied.status, 401)
  const verified = await call(proxy, { path: '/_verify', method: 'GET' })
  assert.equal(verified.status, 200)
  const result = JSON.parse(verified.body.toString())
  assert.equal(result.headers['x-api-key'], '[redacted]')
  assert.equal(result.headers['user-agent'], 'opencode/1.18.35')
  assert.equal(result.headers['anthropic-version'], '2023-06-01')
  for (const name of forbiddenHeaders) assert.equal(result.headers[name], undefined, name)
  for (const secret of [CLIENT_TOKEN, UPSTREAM_KEY, 'test-client']) {
    assert.equal(verified.body.includes(secret), false)
    assert.equal(health.body.includes(secret), false)
  }
  const unknown = await call(proxy, { path: '/api/event_logging/batch' }, '{}')
  assert.equal(unknown.status, 404)
  assert.equal(requests, 0)
})

test('each server keeps its client registry and upstream key separate', TEST_OPTIONS, async (t) => {
  const upstream = await mockServer(t, async (req, res) => {
    await bodyOf(req)
    res.end(String(req.headers['x-api-key']))
  })
  const first = await gateway(t, origin(upstream), {
    tokens: [{ name: 'first', token: 'first-client' }], apiKey: 'first-server-key',
  })
  const second = await gateway(t, origin(upstream), {
    tokens: [{ name: 'second', token: 'second-client' }], apiKey: 'second-server-key',
  })
  assert.equal((await call(first, { token: 'first-client' })).body.toString(), 'first-server-key')
  assert.equal((await call(second, { token: 'second-client' })).body.toString(), 'second-server-key')
  assert.equal((await call(first, { token: 'second-client' })).status, 401)
  assert.equal((await call(second, { token: 'first-client' })).status, 401)
})

test('absolute and ambiguous request targets cannot select another origin', TEST_OPTIONS, async (t) => {
  let intendedRequests = 0
  let foreignRequests = 0
  const foreign = await mockServer(t, (req, res) => { foreignRequests++; req.resume(); res.end() })
  const upstream = await mockServer(t, (req, res) => { intendedRequests++; req.resume(); res.end() })
  const proxy = await gateway(t, origin(upstream))
  const foreignHost = new URL(origin(foreign)).host
  for (const path of [
    `${origin(foreign)}/v1/messages`,
    `//${foreignHost}/v1/messages`,
    `///${foreignHost}/v1/messages`,
    `/\\${foreignHost}/v1/messages`,
    '/v1/messages#fragment',
  ]) {
    const response = await call(proxy, { path }, '{}')
    assert.equal(response.status, 400, path)
  }
  assert.equal(intendedRequests, 0)
  assert.equal(foreignRequests, 0)
})

test('encoded paths and hostile Host headers remain on the configured origin', TEST_OPTIONS, async (t) => {
  const paths: string[] = []
  let foreignRequests = 0
  const foreign = await mockServer(t, (req, res) => { foreignRequests++; req.resume(); res.end() })
  const upstream = await mockServer(t, async (req, res) => {
    await bodyOf(req)
    paths.push(req.url!)
    res.end(req.headers.host)
  })
  const proxy = await gateway(t, origin(upstream))
  const targets = [
    '/v1/%2f%2fexample.test/messages',
    '/v1/%252f%252fexample.test/messages',
    '/v1/messages?target=http%3A%2F%2Fexample.test%2F',
    '/v1/models/name%2Fwith%20spaces?keep=%252F',
  ]
  for (const path of targets) {
    const response = await call(proxy, {
      path,
      headers: { host: new URL(origin(foreign)).host },
    }, '{}')
    assert.equal(response.status, 200)
    assert.equal(response.body.toString(), new URL(origin(upstream)).host)
  }
  assert.deepEqual(paths, targets)
  assert.equal(foreignRequests, 0)
})

test('upstream redirects are returned without forwarding the API key to their destination', TEST_OPTIONS, async (t) => {
  let foreignRequests = 0
  const foreign = await mockServer(t, (req, res) => { foreignRequests++; req.resume(); res.end() })
  const location = `${origin(foreign)}/v1/messages`
  const upstream = await mockServer(t, async (req, res) => {
    await bodyOf(req)
    res.writeHead(307, { location })
    res.end('redirect-body')
  })
  const proxy = await gateway(t, origin(upstream))
  const response = await call(proxy, {}, '{}')
  assert.equal(response.status, 307)
  assert.equal(response.headers.location, location)
  assert.equal(response.body.toString(), 'redirect-body')
  assert.equal(foreignRequests, 0)
})

test('upstream errors preserve status, response bytes and Retry-After', TEST_OPTIONS, async (t) => {
  let status = 400
  const payload = Buffer.from('upstream error: unsupported feature\n')
  const upstream = await mockServer(t, async (req, res) => {
    await bodyOf(req)
    res.writeHead(status, { 'retry-after': '17', 'content-type': 'text/plain', 'request-id': 'upstream-request' })
    res.end(payload)
  })
  const proxy = await gateway(t, origin(upstream))
  for (status of [400, 401, 429, 500, 503]) {
    const response = await call(proxy, {}, '{}')
    assert.equal(response.status, status)
    assert.deepEqual(response.body, payload)
    assert.equal(response.headers['retry-after'], '17')
    assert.equal(response.headers['request-id'], 'upstream-request')
  }
})

test('response hop-by-hop fields and Connection-nominated headers are removed', TEST_OPTIONS, async (t) => {
  const upstream = await mockServer(t, async (req, res) => {
    await bodyOf(req)
    res.writeHead(200, {
      connection: 'keep-alive, X-Upstream-Private',
      'keep-alive': 'timeout=999',
      'x-upstream-private': 'hop-secret',
      'proxy-authenticate': 'Basic realm=private-proxy',
      'content-type': 'text/plain',
      'x-end-to-end': 'preserved',
    })
    res.end('body')
  })
  const proxy = await gateway(t, origin(upstream))
  const response = await call(proxy)
  assert.equal(response.headers['x-upstream-private'], undefined)
  assert.equal(response.headers['keep-alive'], undefined)
  assert.equal(response.headers['proxy-authenticate'], undefined)
  assert.equal(response.headers['x-end-to-end'], 'preserved')
  assert.equal(response.body.toString(), 'body')
  assert.doesNotMatch(response.headers.connection ?? '', /x-upstream-private/i)
})

test('SSE is forwarded before completion and preserves fragmented UTF-8 and unknown events', TEST_OPTIONS, async (t) => {
  const release = deferred()
  const firstChunk = deferred()
  t.after(() => release.resolve())
  const first = Buffer.from('event: message_start\ndata: {"type":"message_start"}\n\n')
  const last = Buffer.from('event: future_event\ndata: {"text":"olá 🌍"}\n\nevent: message_stop\ndata: {}\n\n')
  const upstream = await mockServer(t, async (req, res) => {
    await bodyOf(req)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(first)
    await release.promise
    for (let offset = 0; offset < last.length; offset += 3) res.write(last.subarray(offset, offset + 3))
    res.end()
  })
  const proxy = await gateway(t, origin(upstream))
  let ended = false
  const exchange = openCall(proxy, {
    onResponse: (response) => response.once('data', () => firstChunk.resolve()),
  })
  void exchange.finished.then(() => { ended = true }, () => { ended = true })
  exchange.req.end('{"stream":true}')
  await firstChunk.promise
  assert.equal(ended, false)
  release.resolve()
  const response = await exchange.finished
  assert.equal(response.complete, true)
  assert.equal(response.headers['content-type'], 'text/event-stream')
  assert.deepEqual(response.body, Buffer.concat([first, last]))
})

test('disconnecting the downstream client cancels its upstream stream', TEST_OPTIONS, async (t) => {
  const upstreamClosed = deferred()
  const upstream = await mockServer(t, async (req, res) => {
    await bodyOf(req)
    res.once('close', () => upstreamClosed.resolve())
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"type":"ping"}\n\n')
  })
  const proxy = await gateway(t, origin(upstream))
  const exchange = openCall(proxy, {
    onResponse: (response) => response.once('data', () => response.destroy()),
  })
  exchange.req.end('{}')
  await upstreamClosed.promise
  assert.equal((await exchange.finished).complete, false)
})

test('an upstream reset before headers produces a sanitized 502', TEST_OPTIONS, async (t) => {
  const upstream = await mockServer(t, async (req) => {
    await bodyOf(req)
    req.socket.destroy()
  })
  const proxy = await gateway(t, origin(upstream))
  const response = await call(proxy, {}, '{}')
  assert.equal(response.status, 502)
  assert.equal(JSON.parse(response.body.toString()).error.type, 'api_error')
  assert.equal(response.body.includes(UPSTREAM_KEY), false)
  assert.equal(response.body.includes(CLIENT_TOKEN), false)
})

test('an interrupted upstream stream closes without appending a replacement JSON response', TEST_OPTIONS, async (t) => {
  const interrupt = deferred()
  const firstChunk = deferred()
  t.after(() => interrupt.resolve())
  const initial = Buffer.from('data: {"type":"partial"}\n\n')
  const upstream = await mockServer(t, async (req, res) => {
    await bodyOf(req)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(initial)
    await interrupt.promise
    res.destroy()
  })
  const proxy = await gateway(t, origin(upstream))
  const exchange = openCall(proxy, {
    onResponse: (response) => response.once('data', () => firstChunk.resolve()),
  })
  exchange.req.end('{}')
  await firstChunk.promise
  interrupt.resolve()
  const response = await exchange.finished
  assert.equal(response.status, 200)
  assert.equal(response.complete, false)
  assert.deepEqual(response.body, initial)
  assert.equal(response.body.includes('api_error'), false)
})

test('upstream response headers have a bounded wait', TEST_OPTIONS, async (t) => {
  const upstream = await mockServer(t, (req) => { req.resume() })
  const proxy = await gateway(t, origin(upstream), { server: { upstream_timeout_ms: 150 } })
  const response = await call(proxy, {}, '{}')
  assert.equal(response.status, 504)
  assert.equal(JSON.parse(response.body.toString()).error.message, 'Upstream timed out')
})

test('an idle upstream stream is terminated after headers', TEST_OPTIONS, async (t) => {
  const closed = deferred()
  const upstream = await mockServer(t, async (req, res) => {
    await bodyOf(req)
    res.once('close', () => closed.resolve())
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"type":"ping"}\n\n')
  })
  const proxy = await gateway(t, origin(upstream), { server: { upstream_timeout_ms: 150 } })
  const exchange = openCall(proxy)
  exchange.req.end('{}')
  const response = await exchange.finished
  assert.equal(response.status, 200)
  assert.equal(response.complete, false)
  assert.equal(response.body.toString(), 'data: {"type":"ping"}\n\n')
  await closed.promise
})

test('known and chunked oversized uploads are rejected before reaching upstream', TEST_OPTIONS, async (t) => {
  let requests = 0
  const upstream = await mockServer(t, (req, res) => { requests++; req.resume(); res.end() })
  const proxy = await gateway(t, origin(upstream), { server: { max_body_bytes: 8 } })
  const known = await call(proxy, { headers: { 'content-length': '9' } }, '123456789')
  assert.equal(known.status, 413)
  const chunked = openCall(proxy, { headers: { 'transfer-encoding': 'chunked' } })
  chunked.req.write('12345')
  chunked.req.end('6789')
  assert.equal((await chunked.finished).status, 413)
  assert.equal(requests, 0)
})

test('an incomplete upload receives a bounded 408 without an upstream request', TEST_OPTIONS, async (t) => {
  let requests = 0
  const upstream = await mockServer(t, (req, res) => { requests++; req.resume(); res.end() })
  const proxy = await gateway(t, origin(upstream), { server: { request_timeout_ms: 150 } })
  const exchange = openCall(proxy, { headers: { 'content-length': '10' } })
  t.after(() => exchange.req.destroy())
  exchange.req.write('x')
  const response = await exchange.finished
  assert.equal(response.status, 408)
  assert.equal(response.complete, true)
  assert.equal(requests, 0)
})

test('aborted uploads do not cause an uncaught error or prevent the next request', TEST_OPTIONS, async (t) => {
  let requests = 0
  const upstream = await mockServer(t, (req, res) => { requests++; req.resume(); res.end() })
  const proxy = await gateway(t, origin(upstream))
  const seen = deferred()
  proxy.once('request', () => seen.resolve())
  const exchange = openCall(proxy, { headers: { 'content-length': '100' } })
  const interrupted = exchange.finished.catch(() => undefined)
  exchange.req.write('x')
  await seen.promise
  exchange.req.destroy()
  await interrupted
  await nextTurn()
  await nextTurn()
  const response = await call(proxy, { path: '/_health', method: 'GET', token: null })
  assert.equal(response.status, 200)
  assert.equal(requests, 0)
})
