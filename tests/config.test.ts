import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig, parseConfig } from '../src/config.js'

const env = { CC_GATEWAY_UPSTREAM_API_KEY: 'upstream-secret' }

function input(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { auth: { tokens: [{ name: 'local', token: 'client-secret' }] }, ...extra }
}

function loadConfigFrom(yaml: string, environment: NodeJS.ProcessEnv) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-gateway-config-'))
  try {
    const path = join(directory, 'config.yaml')
    writeFileSync(path, yaml)
    return loadConfig(path, environment)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('API-key configuration supplies safe defaults without OAuth or device identity', () => {
  assert.deepEqual(parseConfig(input(), env), {
    server: {
      host: '127.0.0.1',
      port: 8443,
      max_body_bytes: 33554432,
      request_timeout_ms: 120000,
      upstream_timeout_ms: 600000,
    },
    upstream: {
      url: 'https://api.anthropic.com',
      api_key: 'upstream-secret',
      fallback_api_keys: [],
      user_agent: 'opencode/1.18.35',
    },
    auth: { tokens: [{ name: 'local', token: 'client-secret' }] },
    logging: { level: 'info', audit: false },
  })
})

test('additional upstream keys come only from the private environment, in order', () => {
  const keys = ['fallback-one', 'fallback-two', 'fallback-three']
  const config = parseConfig(input(), { ...env, CC_GATEWAY_FALLBACK_API_KEYS: JSON.stringify(keys) })
  assert.equal(config.upstream.api_key, 'upstream-secret')
  assert.deepEqual(config.upstream.fallback_api_keys, keys)
  for (const value of [undefined, '', '  \n', '[]', ' [ ] ']) {
    assert.deepEqual(parseConfig(input(), { ...env, CC_GATEWAY_FALLBACK_API_KEYS: value }).upstream.fallback_api_keys, [])
  }
  // The YAML file can never carry credentials, whatever the field is called.
  for (const field of ['fallback_api_keys', 'api_keys', 'keys']) {
    assert.throws(() => parseConfig(input({ upstream: { [field]: keys } }), env), /unsupported fields/)
  }
  assert.deepEqual(loadConfigFrom('auth:\n  tokens:\n    - name: local\n      token: client-secret\n',
    { ...env, CC_GATEWAY_FALLBACK_API_KEYS: JSON.stringify(keys) }).upstream.fallback_api_keys, keys)
})

test('at most seven additional keys are accepted, eight upstream keys in total', () => {
  const seven = Array.from({ length: 7 }, (_, index) => `fallback-${index}`)
  assert.equal(parseConfig(input(), { ...env, CC_GATEWAY_FALLBACK_API_KEYS: JSON.stringify(seven) }).upstream.fallback_api_keys?.length, 7)
  assert.throws(() => parseConfig(input(), { ...env, CC_GATEWAY_FALLBACK_API_KEYS: JSON.stringify([...seven, 'fallback-7']) }), /at most 7/)
})

test('additional keys must be valid credentials, unique, and distinct from every client token', () => {
  const secret = 'must-never-be-printed'
  const fallback = (value: unknown) => ({ ...env, CC_GATEWAY_FALLBACK_API_KEYS: typeof value === 'string' ? value : JSON.stringify(value) })
  for (const value of [
    '{not json', 'null', '"text"', '7', '{"key":"a"}', `{"${secret}":1}`,
    [1], [null], [[secret]], [{ key: secret }], [''], [`${secret} with space`], [`${secret}\n`], [`${secret}-☃`],
  ]) {
    assert.throws(() => parseConfig(input(), fallback(value)), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /CC_GATEWAY_FALLBACK_API_KEYS/)
      assert.ok(!error.message.includes(secret))
      return true
    })
  }
  for (const value of [['upstream-secret'], ['fallback-one', 'fallback-one'], ['fallback-one', 'upstream-secret']]) {
    assert.throws(() => parseConfig(input(), fallback(value)), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /must be unique/)
      assert.ok(!error.message.includes('fallback-one') && !error.message.includes('upstream-secret'))
      return true
    })
  }
  assert.throws(() => parseConfig(input({
    auth: { tokens: [{ name: 'local', token: 'fallback-one' }] },
  }), fallback(['fallback-one'])), /must differ from every upstream API key/)
})

test('explicit server, TLS, limits, identity and logging settings are retained', () => {
  const config = parseConfig(input({
    server: {
      host: '::1', port: 0,
      tls: { cert: 'certs/server cert.pem', key: 'certs/server key.pem' },
      max_body_bytes: 1024, request_timeout_ms: 1000, upstream_timeout_ms: 2000,
    },
    upstream: { url: 'https://api.anthropic.com:443/', user_agent: 'opencode/1.19.0' },
    logging: { level: 'warn', audit: true },
  }), env)
  assert.deepEqual(config.server, {
    host: '::1', port: 0,
    tls: { cert: 'certs/server cert.pem', key: 'certs/server key.pem' },
    max_body_bytes: 1024, request_timeout_ms: 1000, upstream_timeout_ms: 2000,
  })
  assert.equal(config.upstream.url, 'https://api.anthropic.com')
  assert.equal(config.upstream.user_agent, 'opencode/1.19.0')
  assert.deepEqual(config.logging, { level: 'warn', audit: true })
})

test('the upstream API key must come from the dedicated environment variable', () => {
  for (const value of [undefined, '', 'with space', 'secret\nvalue', 'secret\n', 'non-ascii-☃']) {
    assert.throws(() => parseConfig(input(), { CC_GATEWAY_UPSTREAM_API_KEY: value }), /CC_GATEWAY_UPSTREAM_API_KEY/)
  }
  assert.throws(() => parseConfig(input(), { ANTHROPIC_API_KEY: 'client-secret' }), /CC_GATEWAY_UPSTREAM_API_KEY/)
  assert.throws(() => parseConfig(input({ upstream: { api_key: 'stored-secret' } }), env), /unsupported fields/)
  assert.throws(() => parseConfig(input({
    auth: { tokens: [{ name: 'bad', token: 'upstream-secret' }] },
  }), env), /must differ/)
})

test('unknown fields and obsolete configuration are rejected without echoing values', () => {
  const secret = 'must-never-be-printed'
  for (const field of ['oauth', 'identity', 'env', 'process', 'prompt_env', 'unexpected']) {
    assert.throws(() => parseConfig(input({ [field]: { secret } }), env), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /unsupported fields/)
      assert.ok(!error.message.includes(secret))
      return true
    })
  }
  for (const extra of [
    { server: { unknown: secret } },
    { upstream: { unknown: secret } },
    { auth: { tokens: [{ name: 'local', token: 'client-secret', unknown: secret }] } },
    { logging: { unknown: secret } },
    { server: { tls: { cert: 'cert.pem', key: 'key.pem', unknown: secret } } },
  ]) {
    assert.throws(() => parseConfig(input(extra), env), /unsupported fields/)
  }
})

test('configuration objects and client entries have validated shapes', () => {
  for (const value of [undefined, null, [], 'text', 1, new Date(), Object.create({ auth: {} })]) {
    assert.throws(() => parseConfig(value, env), /must be an object/)
  }
  for (const field of ['server', 'upstream', 'auth', 'logging']) {
    for (const value of [null, [], 'text']) {
      assert.throws(() => parseConfig(input({ [field]: value }), env), /must be an object/)
    }
  }
  for (const tokens of [undefined, [], 'text', [null], [{ name: 'local' }], [{ token: 'client-secret' }]]) {
    assert.throws(() => parseConfig(input({ auth: { tokens } }), env))
  }
})

test('client names and credentials must be distinct and valid', () => {
  for (const tokens of [
    [{ name: 'local', token: 'a' }, { name: 'local', token: 'b' }],
    [{ name: 'one', token: 'a' }, { name: 'two', token: 'a' }],
    [{ name: '', token: 'a' }],
    [{ name: 'newline\nname', token: 'a' }],
    [{ name: 'local', token: '' }],
    [{ name: 'local', token: 'white space' }],
    [{ name: 'local', token: 'secret\r\nvalue' }],
  ]) {
    assert.throws(() => parseConfig(input({ auth: { tokens } }), env))
  }
  assert.equal(parseConfig(input({
    auth: { tokens: [{ name: 'one', token: 'a' }, { name: 'two', token: 'b' }] },
  }), env).auth.tokens.length, 2)
})

test('server numeric settings reject zero deadlines and out-of-range values', () => {
  for (const port of [-1, 65536, 1.5, '8443', null, Infinity, NaN]) {
    assert.throws(() => parseConfig(input({ server: { port } }), env), /server.port/)
  }
  for (const field of ['max_body_bytes', 'request_timeout_ms', 'upstream_timeout_ms']) {
    for (const value of [-1, 0, 1.5, '1000', null, 2 ** 31, Infinity, NaN]) {
      assert.throws(() => parseConfig(input({ server: { [field]: value } }), env), new RegExp(field))
    }
  }
})

test('server bind host, TLS and logging must be explicit valid values', () => {
  for (const host of ['', 'example.com', '127.0.0.1\n', null]) {
    assert.throws(() => parseConfig(input({ server: { host } }), env), /server.host/)
  }
  for (const tls of [null, {}, { cert: 'cert.pem' }, { key: 'key.pem' }, { cert: '', key: 'key.pem' }]) {
    assert.throws(() => parseConfig(input({ server: { tls } }), env), /server.tls/)
  }
  for (const logging of [{ audit: 'false' }, { audit: null }, { level: 'verbose' }, { level: null }]) {
    assert.throws(() => parseConfig(input({ logging }), env), /logging/)
  }
  assert.equal(parseConfig(input({ server: { host: '0.0.0.0' } }), env).server.host, '0.0.0.0')
})

test('upstream URLs are origin-only with HTTP restricted to loopback', () => {
  for (const url of [
    'https://api.anthropic.com',
    'https://example.com:9443/',
    'http://127.0.0.1:8080',
    'http://127.0.0.2:8080',
    'http://localhost:8080',
    'http://[::1]:8080',
  ]) {
    assert.equal(parseConfig(input({ upstream: { url } }), env).upstream.url, new URL(url).origin)
  }
  for (const url of [
    '', '/relative', 'ftp://example.com', 'http://example.com',
    'http://127.0.0.1.example.com', 'http://[::]',
    'https://user:secret@example.com', 'https://example.com/path',
    'https://example.com?token=secret', 'https://example.com#fragment',
    'https://example.com?', 'https://example.com#', 'https:\\example.com',
    'https://example.com\n',
  ]) {
    assert.throws(() => parseConfig(input({ upstream: { url } }), env), /upstream.url/)
  }
})

test('the configured User-Agent cannot reintroduce Claude identity or injected headers', () => {
  for (const user_agent of [
    'claude-cli/2.1.296 (external, cli)', 'claude-code/2.1.296',
    'opencode/1.18.35 (external, cli)', 'opencode/1.18.35 runtime/node',
    'opencode/1.18.35\r\nx-app: cli', 'opencode/1.18.35\n', '', null,
  ]) {
    assert.throws(() => parseConfig(input({ upstream: { user_agent } }), env), /user_agent/)
  }
})

test('loadConfig reads a selected file with an explicit environment', t => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-gateway-config-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'config.yaml')
  writeFileSync(path, 'auth:\n  tokens:\n    - name: local\n      token: client-secret\n')
  assert.equal(loadConfig(path, env).upstream.api_key, 'upstream-secret')
})

test('YAML and filesystem failures return static messages without source snippets', t => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-gateway-config-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'config.yaml')
  writeFileSync(path, 'auth: [must-never-be-printed\n')
  assert.throws(() => loadConfig(path, env), { message: 'config: invalid YAML' })
  assert.throws(() => loadConfig(join(directory, 'absent.yaml'), env), {
    message: 'config: unable to read configuration file',
  })
})
