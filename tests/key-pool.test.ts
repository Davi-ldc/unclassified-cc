import assert from 'node:assert/strict'
import { test } from 'node:test'
import { KeyPool, keyFailure, MAX_COOLDOWN_MS } from '../src/key-pool.js'

// A whole number of seconds, so HTTP dates round-trip without losing milliseconds.
const START = 1_700_000_000_000

function clock() {
  let now = START
  return { now: () => now, advance(ms: number) { now += ms } }
}

test('a pool holds between one and eight keys', () => {
  for (const count of [0, 9, -1, 1.5, NaN]) assert.throws(() => new KeyPool(count), /Invalid upstream key count/)
  for (const count of [1, 2, 8]) {
    assert.deepEqual(new KeyPool(count).candidates(), Array.from({ length: count }, (_, index) => index))
  }
})

test('each failure reason has its own default cooldown that ends exactly at its deadline', () => {
  for (const [reason, duration] of [
    ['authentication', 60_000], ['billing', 60_000], ['rate_limit', 30_000], ['transient', 5_000],
  ] as const) {
    const time = clock()
    const pool = new KeyPool(2, time.now)
    pool.defer(0, reason)
    assert.deepEqual(pool.candidates(), [1], reason)
    assert.equal(pool.available(0), false, reason)
    time.advance(duration - 1)
    assert.deepEqual(pool.candidates(), [1], reason)
    time.advance(1)
    assert.deepEqual(pool.candidates(), [0, 1], reason)
    assert.equal(pool.available(0), true, reason)
  }
})

test('Retry-After lengthens a cooldown but never shortens it, and stays bounded', () => {
  const cases: Array<[string | undefined, number]> = [
    [undefined, 30_000], ['', 30_000], ['0', 30_000], ['10', 30_000], ['10.5', 30_000],
    ['120', 120_000], ['120.5', 120_500], [' 90 ', 90_000],
    [new Date(START + 90_000).toUTCString(), 90_000],
    [new Date(START - 90_000).toUTCString(), 30_000],
    ['later', 30_000], ['9'.repeat(200), 30_000],
    ['86400', MAX_COOLDOWN_MS], [new Date(START + 86_400_000).toUTCString(), MAX_COOLDOWN_MS],
  ]
  for (const [header, duration] of cases) {
    const time = clock()
    const pool = new KeyPool(2, time.now)
    pool.defer(0, 'rate_limit', header)
    time.advance(duration - 1)
    assert.equal(pool.available(0), false, String(header))
    time.advance(1)
    assert.equal(pool.available(0), true, String(header))
  }
})

test('a later failure never shortens an existing cooldown', () => {
  const time = clock()
  const pool = new KeyPool(2, time.now)
  pool.defer(0, 'authentication')
  pool.defer(0, 'transient')
  time.advance(59_999)
  assert.equal(pool.available(0), false)
  time.advance(1)
  assert.equal(pool.available(0), true)
})

test('a single key is never taken out of rotation', () => {
  const time = clock()
  const pool = new KeyPool(1, time.now)
  for (const reason of ['authentication', 'billing', 'rate_limit', 'transient'] as const) pool.defer(0, reason, '300')
  assert.deepEqual(pool.candidates(), [0])
  assert.equal(pool.available(0), true)
})

test('pools keep independent state', () => {
  const time = clock()
  const first = new KeyPool(2, time.now)
  const second = new KeyPool(2, time.now)
  first.defer(0, 'billing')
  assert.deepEqual(first.candidates(), [1])
  assert.deepEqual(second.candidates(), [0, 1])
})

test('the retry hint reports the soonest availability in whole seconds, at least one', () => {
  const time = clock()
  const pool = new KeyPool(3, time.now)
  pool.defer(0, 'rate_limit')
  pool.defer(1, 'authentication')
  pool.defer(2, 'transient')
  assert.equal(pool.retryAfter(), 5)
  time.advance(1_500)
  assert.equal(pool.retryAfter(), 4)
  time.advance(10_000)
  assert.equal(pool.retryAfter(), 1)
})

const body = (value: unknown) => Buffer.from(JSON.stringify(value))
const failure = (type: string, message: string) => body({ type: 'error', error: { type, message } })
const BILLING = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'

test('rate limits and server failures are eligible without inspecting a body', () => {
  assert.equal(keyFailure(429), 'rate_limit')
  for (const status of [500, 502, 503, 504]) assert.equal(keyFailure(status), 'transient', String(status))
  for (const status of [200, 201, 301, 400, 401, 403, 404, 408, 413, 422, 501, 505, 529]) {
    assert.equal(keyFailure(status), undefined, String(status))
  }
})

test('only upstream authentication errors on 401 are eligible', () => {
  assert.equal(keyFailure(401, failure('authentication_error', 'invalid x-api-key')), 'authentication')
  assert.equal(keyFailure(401, failure('permission_error', 'invalid x-api-key')), undefined)
  assert.equal(keyFailure(401, failure('invalid_request_error', 'invalid x-api-key')), undefined)
  assert.equal(keyFailure(403, failure('authentication_error', 'invalid x-api-key')), undefined)
  assert.equal(keyFailure(400, failure('authentication_error', 'invalid x-api-key')), undefined)
})

test('only the exhausted-balance 400 is eligible', () => {
  assert.equal(keyFailure(400, failure('invalid_request_error', BILLING)), 'billing')
  assert.equal(keyFailure(400, failure('invalid_request_error', 'Credit balance is too low')), 'billing')
  assert.equal(keyFailure(400, failure('invalid_request_error', 'credit balance too low')), 'billing')
  assert.equal(keyFailure(400, failure('invalid_request_error', 'max_tokens: required')), undefined)
  assert.equal(keyFailure(400, failure('api_error', BILLING)), undefined)
  assert.equal(keyFailure(401, failure('invalid_request_error', BILLING)), undefined)
  assert.equal(keyFailure(403, failure('invalid_request_error', BILLING)), undefined)
})

test('unrecognized or malformed error bodies are never eligible', () => {
  for (const payload of [
    Buffer.alloc(0), Buffer.from('<html>bad gateway</html>'), Buffer.from('{"type":'), body(null), body([]), body('text'),
    body({ type: 'message' }), body({ type: 'error' }), body({ type: 'error', error: null }),
    body({ type: 'error', error: { type: 'invalid_request_error', message: 7 } }),
    body({ type: 'error', error: { type: 'invalid_request_error' } }),
  ]) {
    assert.equal(keyFailure(400, payload), undefined)
    assert.equal(keyFailure(401, payload), undefined)
  }
})
