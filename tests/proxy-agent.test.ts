import assert from 'node:assert/strict'
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { test } from 'node:test'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { bypassProxy, createUpstreamAgent } from '../src/proxy-agent.js'

const cases: Array<[string, string, boolean]> = [
  ['https://api.example.test', '', false],
  ['https://api.example.test', '*', true],
  ['https://api.example.test', 'api.example.test', true],
  ['https://api.example.test', 'API.EXAMPLE.TEST', true],
  ['https://api.example.test', 'example.test', false],
  ['https://api.example.test', '.example.test', true],
  ['https://example.test', '.example.test', true],
  ['https://api.example.test', '*.example.test', true],
  ['https://notexample.test', '.example.test', false],
  ['https://api.example.test.evil.test', '.example.test', false],
  ['https://api.example.test', 'api.example.test:443', true],
  ['https://api.example.test', 'api.example.test:80', false],
  ['https://api.example.test:8443', 'api.example.test:8443', true],
  ['https://api.example.test:8443', 'api.example.test:443', false],
  ['http://api.example.test', 'api.example.test:80', true],
  ['http://api.example.test', 'api.example.test:443', false],
  ['http://127.0.0.1:1234', '127.0.0.1', true],
  ['http://127.0.0.10:1234', '127.0.0.1', false],
  ['http://localhost:1234', 'localhost:1234', true],
  ['http://[::1]:8443', '::1', true],
  ['http://[::1]:8443', '[::1]', true],
  ['http://[::1]:8443', '[::1]:8443', true],
  ['http://[::1]:8443', '[::1]:443', false],
  ['http://[::2]:8443', '[::1]:8443', false],
  ['https://api.example.test', 'unused.test, api.example.test:443 other.test', true],
  ['https://api.example.test', 'unused.test\tother.test\n', false],
]

for (const [target, noProxy, expected] of cases) {
  test(`NO_PROXY ${JSON.stringify(noProxy)} for ${target}`, () => {
    assert.equal(bypassProxy(new URL(target), noProxy), expected)
  })
}

test('direct agents match their target protocol and have independent lifetimes', (t) => {
  const http = createUpstreamAgent(new URL('http://127.0.0.1:8443'), {})
  const https = createUpstreamAgent(new URL('https://api.example.test'), {})
  const another = createUpstreamAgent(new URL('https://api.example.test'), {})
  t.after(() => { http.destroy(); https.destroy(); another.destroy() })
  assert.ok(http instanceof HttpAgent)
  assert.equal(http instanceof HttpsAgent, false)
  assert.ok(https instanceof HttpsAgent)
  assert.notEqual(https, another)
})

test('proxy environment is resolved for each factory call', (t) => {
  const target = new URL('https://api.example.test')
  const first = createUpstreamAgent(target, { HTTPS_PROXY: 'http://127.0.0.1:8101' })
  const second = createUpstreamAgent(target, { HTTPS_PROXY: 'http://127.0.0.1:8102' })
  const direct = createUpstreamAgent(target, {})
  t.after(() => { first.destroy(); second.destroy(); direct.destroy() })
  assert.ok(first instanceof HttpsProxyAgent)
  assert.ok(second instanceof HttpsProxyAgent)
  assert.equal(first.proxy.href, 'http://127.0.0.1:8101/')
  assert.equal(second.proxy.href, 'http://127.0.0.1:8102/')
  assert.equal(direct instanceof HttpsProxyAgent, false)
})

test('HTTPS selects its proxy before the HTTP and all-protocol fallbacks', (t) => {
  const agent = createUpstreamAgent(new URL('https://api.example.test'), {
    HTTPS_PROXY: 'http://127.0.0.1:8201',
    HTTP_PROXY: 'http://127.0.0.1:8202',
    ALL_PROXY: 'http://127.0.0.1:8203',
  })
  t.after(() => agent.destroy())
  assert.ok(agent instanceof HttpsProxyAgent)
  assert.equal(agent.proxy.port, '8201')
})

test('HTTP ignores an HTTPS-only proxy setting', (t) => {
  const agent = createUpstreamAgent(new URL('http://127.0.0.1:8443'), {
    HTTPS_PROXY: 'http://127.0.0.1:8301',
    HTTP_PROXY: 'http://127.0.0.1:8302',
  })
  t.after(() => agent.destroy())
  assert.ok(agent instanceof HttpsProxyAgent)
  assert.equal(agent.proxy.port, '8302')
})

test('lowercase proxy and no_proxy settings take precedence', (t) => {
  const target = new URL('https://api.example.test')
  const proxied = createUpstreamAgent(target, {
    https_proxy: 'http://127.0.0.1:8401',
    HTTPS_PROXY: 'http://127.0.0.1:8402',
    no_proxy: '',
    NO_PROXY: '*',
  })
  const direct = createUpstreamAgent(target, {
    HTTPS_PROXY: 'http://127.0.0.1:8402',
    no_proxy: 'api.example.test',
    NO_PROXY: 'other.example.test',
  })
  t.after(() => { proxied.destroy(); direct.destroy() })
  assert.ok(proxied instanceof HttpsProxyAgent)
  assert.equal(proxied.proxy.port, '8401')
  assert.equal(direct instanceof HttpsProxyAgent, false)
})

test('HTTP_PROXY and ALL_PROXY provide explicit fallbacks', (t) => {
  const httpFallback = createUpstreamAgent(new URL('https://api.example.test'), {
    HTTP_PROXY: 'http://127.0.0.1:8501',
  })
  const allFallback = createUpstreamAgent(new URL('https://api.example.test'), {
    ALL_PROXY: 'http://127.0.0.1:8502',
  })
  t.after(() => { httpFallback.destroy(); allFallback.destroy() })
  assert.ok(httpFallback instanceof HttpsProxyAgent)
  assert.ok(allFallback instanceof HttpsProxyAgent)
  assert.equal(httpFallback.proxy.port, '8501')
  assert.equal(allFallback.proxy.port, '8502')
})

test('unsupported outbound proxy schemes are rejected without contacting them', () => {
  assert.throws(
    () => createUpstreamAgent(new URL('https://api.example.test'), { HTTPS_PROXY: 'socks5://127.0.0.1:8601' }),
    /HTTP or HTTPS/,
  )
})
