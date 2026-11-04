import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gzipSync, gunzipSync } from 'node:zlib'
import { prepareNeutralRequest } from '../src/body.js'
import { OPUS_FAST_BETA, OPUS_FAST_MODEL } from '../src/inference.js'
import { createProxyServer } from '../src/proxy.js'
import { bodyOf, call, configFor, gateway, listen, mockServer, origin, TEST_OPTIONS } from './support.js'

const path = '/opus-fast/v1/messages'

test('Opus Fast pins generation, preserves signed history, and streams the response', TEST_OPTIONS, async t => {
  const signed = '{"type":"thinking", "thinking":"", "signature":"opaque\\u002bsignature"}'
  const upstream = await mockServer(t, async (req, res) => {
    const raw = gunzipSync(await bodyOf(req)).toString()
    const body = JSON.parse(raw)
    assert.equal(req.url, '/v1/messages?beta=true')
    assert.equal(req.headers['anthropic-beta'], OPUS_FAST_BETA)
    assert.equal(body.model, OPUS_FAST_MODEL)
    assert.equal(body.speed, 'fast')
    assert.deepEqual(body.thinking, { type: 'adaptive' })
    assert.deepEqual(body.output_config, { effort: 'high' })
    for (const key of ['fallbacks', 'temperature', 'top_p', 'top_k']) assert.equal(body[key], undefined)
    assert.ok(raw.includes(signed))
    assert.ok(raw.includes('9007199254740993'))
    assert.equal(body.tools[0].name, 'shell')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_fast","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"usage":{"speed":"fast"}}}\n\n')
  })
  const proxy = await gateway(t, origin(upstream))
  const request = `{"model":"claude-haiku-4-5","speed":"standard","stream":true,"max_tokens":64,"thinking":{"type":"disabled"},"output_config":{"effort":"high"},"temperature":0,"top_p":0.9,"top_k":1,"fallbacks":"default","future_number":9007199254740993,"tools":[{"name":"Bash","input_schema":{"type":"object","properties":{}}}],"messages":[{"role":"assistant","content":[${signed},{"type":"text","text":"Previous response"}]},{"role":"user","content":"Reply OK"}]}`
  const response = await call(proxy, { path: path + '?beta=true', headers: { 'content-encoding': 'gzip', 'anthropic-beta': 'unrelated-beta' } }, gzipSync(Buffer.from(request)))
  assert.equal(response.status, 200)
  assert.match(response.body.toString(), /"speed":"fast"/)
})

test('token counting pins the same model without sending generation speed or fallback fields', TEST_OPTIONS, async t => {
  const upstream = await mockServer(t, async (req, res) => {
    const body = JSON.parse((await bodyOf(req)).toString())
    assert.equal(req.url, '/v1/messages/count_tokens')
    assert.equal(req.headers['anthropic-beta'], undefined)
    assert.equal(body.model, OPUS_FAST_MODEL)
    assert.equal(body.speed, undefined)
    assert.equal(body.fallbacks, undefined)
    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' })
    res.end('{"input_tokens":10}')
  })
  const proxy = await gateway(t, origin(upstream))
  const response = await call(proxy, { path: path + '/count_tokens' }, JSON.stringify({
    model: 'claude-sonnet-4-6', speed: 'fast', fallbacks: [{ model: 'other' }],
    thinking: { type: 'adaptive', display: 'summarized', budget_tokens: 1024 }, messages: [],
  }))
  assert.equal(response.status, 200)
})

test('credential retries and client standard-speed retries remain Opus 5.5 Fast', TEST_OPTIONS, async t => {
  let attempts = 0
  const upstream = await mockServer(t, async (req, res) => {
    attempts++
    const body = JSON.parse((await bodyOf(req)).toString())
    assert.equal(body.model, OPUS_FAST_MODEL)
    assert.equal(body.speed, 'fast')
    assert.equal(req.headers['anthropic-beta'], OPUS_FAST_BETA)
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
    res.end('{"error":{"type":"rate_limit_error","message":"Fast capacity unavailable"}}')
  })
  const config = configFor(origin(upstream))
  config.upstream.fallback_api_keys = ['dummy-secondary-key']
  let now = Date.now()
  const proxy = await listen(t, createProxyServer(config, {}, { now: () => now }))
  for (const speed of ['fast', 'standard']) {
    const response = await call(proxy, { path }, JSON.stringify({ model: 'other', speed, messages: [] }))
    assert.equal(response.status, 429)
    now += 60_000
  }
  assert.equal(attempts, 4)
})

test('Opus Fast verification exposes the inference policy and rejects batch generation', TEST_OPTIONS, async t => {
  let requests = 0
  const upstream = await mockServer(t, async (req, res) => {
    requests++
    assert.equal(req.url, '/v1/models')
    res.end('{"data":[]}')
  })
  const proxy = await gateway(t, origin(upstream))
  const verified = await call(proxy, { path: '/opus-fast/_verify', method: 'GET' })
  assert.equal(verified.status, 200)
  assert.deepEqual(JSON.parse(verified.body.toString()).inference, { model: OPUS_FAST_MODEL, speed: 'fast', beta: OPUS_FAST_BETA })
  assert.equal((await call(proxy, { path: path + '/batches' }, '{}')).status, 400)
  assert.equal((await call(proxy, { path: '/opus-fast/v1/models', method: 'GET' })).status, 200)
  assert.equal(requests, 1)
})

test('Opus Fast rejects malformed and duplicate bodies and checks the rewritten size', async () => {
  for (const input of ['', 'null', '{"model":"first","model":"second"}']) {
    await assert.rejects(prepareNeutralRequest(Buffer.from(input), '/v1/messages', undefined, 4096, 'neutral-v2', true), { status: 400 })
  }
  await assert.rejects(prepareNeutralRequest(Buffer.from('{}'), '/v1/messages', undefined, 2, 'neutral-v2', true), { status: 413 })
})
