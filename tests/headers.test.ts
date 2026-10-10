import assert from 'node:assert/strict'
import type { IncomingHttpHeaders } from 'node:http'
import { test } from 'node:test'
import type { Config } from '../src/config.js'
import { buildUpstreamHeaders, DEFAULT_USER_AGENT } from '../src/headers.js'

const upstream: Config['upstream'] = {
  url: 'https://api.anthropic.com',
  api_key: 'upstream-secret',
  user_agent: DEFAULT_USER_AGENT,
}

test('a fresh header set supplies the gateway identity, authentication and framing', () => {
  assert.deepEqual(buildUpstreamHeaders({}, upstream, 17), {
    'anthropic-version': '2023-06-01',
    'user-agent': 'opencode/1.18.35',
    'x-api-key': 'upstream-secret',
    'content-length': '17',
  })
})

test('the allowlist excludes Claude, OpenCode, SDK, session and unknown headers', () => {
  const input: IncomingHttpHeaders = {
    'User-Agent': 'claude-cli/2.1.296 (external, cli)',
    'X-App': 'cli',
    'ANTHROPIC-BETA': ['first-beta', 'second-beta'],
    'X-Claude-Code-Session-Id': 'claude-session',
    'x-claude-code-agent-id': 'claude-agent',
    'x-opencode-session-id': 'opencode-session',
    'x-session-affinity': 'session-affinity',
    'X-Session-Id': 'session',
    'x-stainless-os': 'Linux',
    'x-stainless-runtime': 'node',
    'x-anthropic-billing-header': 'billing-fingerprint',
    traceparent: 'trace-id',
    baggage: 'session-id',
    cookie: 'session=private',
    'x-forwarded-for': '192.0.2.1',
    'x-unknown-future-header': 'private-value',
    host: 'foreign.example',
    connection: 'keep-alive',
    'proxy-connection': 'keep-alive',
    'transfer-encoding': 'chunked',
    'content-length': '999999',
    authorization: 'Bearer client-secret',
    'proxy-authorization': 'Bearer proxy-secret',
    'x-api-key': 'client-secret',
    'content-type': 'application/json',
  }
  assert.deepEqual(buildUpstreamHeaders(input, upstream, 4), {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'user-agent': 'opencode/1.18.35',
    'x-api-key': 'upstream-secret',
    'content-length': '4',
  })
})

test('Connection cannot turn forwarded representation metadata into hop-by-hop fields', () => {
  for (const connection of ['content-type', 'keep-alive, Content-Encoding', 'accept', 'anthropic-version']) {
    assert.throws(() => buildUpstreamHeaders({
      Connection: connection,
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    }, upstream, 2), /hop-by-hop/)
  }
  assert.equal(buildUpstreamHeaders({ connection: 'keep-alive, x-private' }, upstream, 0)['user-agent'], DEFAULT_USER_AGENT)
})

test('protocol and content negotiation headers are preserved with canonical names', () => {
  assert.deepEqual(buildUpstreamHeaders({
    'Anthropic-Version': '2023-06-01',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Encoding': 'gzip',
    Accept: 'text/event-stream',
    'Accept-Encoding': 'gzip, br',
  }, upstream, 9), {
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json; charset=utf-8',
    'content-encoding': 'gzip',
    accept: 'text/event-stream',
    'accept-encoding': 'gzip, br',
    'user-agent': 'opencode/1.18.35',
    'x-api-key': 'upstream-secret',
    'content-length': '9',
  })
})

test('headersDistinct arrays retain list order and accept one value for singleton fields', () => {
  const headers: NodeJS.Dict<string[]> = {
    'anthropic-version': ['2023-06-01'],
    'content-type': ['application/json'],
    accept: ['application/json', 'text/event-stream'],
    'accept-encoding': ['gzip', 'br'],
    'content-encoding': ['gzip', 'br'],
  }
  const result = buildUpstreamHeaders(headers, upstream, 0)
  assert.equal(result['content-type'], 'application/json')
  assert.equal(result.accept, 'application/json, text/event-stream')
  assert.equal(result['accept-encoding'], 'gzip, br')
  assert.equal(result['content-encoding'], 'gzip, br')
})

test('duplicate singleton headers are rejected across arrays and mixed-case names', () => {
  const cases: Array<NodeJS.Dict<string | string[]>> = [
    { 'anthropic-version': ['2023-06-01', '2023-06-01'] },
    { 'Anthropic-Version': '2023-06-01', 'anthropic-version': '2023-06-01' },
    { 'content-type': ['application/json', 'text/plain'] },
    { 'Content-Type': 'application/json', 'content-type': 'text/plain' },
  ]
  for (const headers of cases) {
    assert.throws(() => buildUpstreamHeaders(headers, upstream, 0), /Duplicate request header/)
  }
})

test('malformed allowed values fail without exposing their contents', () => {
  const cases: Array<NodeJS.Dict<string | string[]>> = [
    { 'content-type': '' },
    { accept: [] },
    { 'accept-encoding': ['gzip', ''] },
    { 'content-type': 'application/json\r\nx-private: sensitive-value' },
    { accept: '☃' },
  ]
  for (const headers of cases) {
    assert.throws(() => buildUpstreamHeaders(headers, upstream, 0), error => {
      assert.ok(error instanceof TypeError)
      assert.match(error.message, /Invalid request header/)
      assert.ok(!error.message.includes('sensitive-value'))
      return true
    })
  }
})

test('protocol versions have an unambiguous calendar-date format', () => {
  for (const version of ['invalid', '2023-2-1', '2023-02-29', '2023-13-01', '2023-06-01,2023-06-01', '2023-06-01\n']) {
    assert.throws(() => buildUpstreamHeaders({ 'anthropic-version': version }, upstream, 0), /anthropic-version/)
  }
  assert.equal(buildUpstreamHeaders({ 'anthropic-version': '2024-02-29' }, upstream, 0)['anthropic-version'], '2024-02-29')
})

test('input headers and arrays remain unchanged', () => {
  const accepts = Object.freeze(['application/json', 'text/event-stream'])
  const headers = Object.freeze({
    accept: accepts,
    'user-agent': 'claude-code/2.1.296 (external, cli)',
  })
  const result = buildUpstreamHeaders(headers as unknown as IncomingHttpHeaders, upstream, 0)
  assert.equal(result.accept, 'application/json, text/event-stream')
  assert.deepEqual(accepts, ['application/json', 'text/event-stream'])
  assert.equal(headers['user-agent'], 'claude-code/2.1.296 (external, cli)')
})

test('caller overrides cannot replace the server identity or key', () => {
  const result = buildUpstreamHeaders({
    'X-API-Key': ['client-secret', 'another-client-secret'],
    'USER-AGENT': ['claude-cli/2.1.296', 'another-agent'],
    'Content-Length': '9000',
  }, upstream, 3)
  assert.equal(result['x-api-key'], 'upstream-secret')
  assert.equal(result['user-agent'], 'opencode/1.18.35')
  assert.equal(result['content-length'], '3')
})

test('invalid runtime identity, credentials and framing are rejected defensively', () => {
  for (const user_agent of ['claude-cli/2.1.296', 'opencode/1.18.35\n', 'opencode/1.18.35' + String.fromCharCode(0x2028), 'opencode/1.18.35 runtime/node']) {
    assert.throws(() => buildUpstreamHeaders({}, { ...upstream, user_agent }, 0), /User-Agent/)
  }
  for (const api_key of ['', 'sensitive-value\n', 'sensitive-value\r\nx-app: cli', 'white space']) {
    assert.throws(() => buildUpstreamHeaders({}, { ...upstream, api_key }, 0), error => {
      assert.ok(error instanceof TypeError)
      assert.equal(error.message, 'Invalid upstream API key')
      return true
    })
  }
  for (const length of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => buildUpstreamHeaders({}, upstream, length), /content length/)
  }
})
