import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { test } from 'node:test'
import { createAuthenticator } from '../src/auth.js'

const tokens = [{ name: 'local', token: 'client-secret' }]

function request(headers: NodeJS.Dict<string | string[]> = {}, rawHeaders: string[] = []): IncomingMessage {
  return { headers, rawHeaders } as IncomingMessage
}

test('gateway authentication accepts an API key or either Bearer header', () => {
  const authenticate = createAuthenticator(tokens)
  assert.equal(authenticate(request({ 'x-api-key': 'client-secret' })), 'local')
  assert.equal(authenticate(request({ authorization: 'Bearer client-secret' })), 'local')
  assert.equal(authenticate(request({ 'proxy-authorization': 'bEaReR client-secret' })), 'local')
  assert.equal(authenticate(request({ 'X-Api-Key': 'client-secret' })), 'local')
  assert.equal(authenticate(request({ authorization: 'Bearer\tclient-secret' })), 'local')
})

test('missing, unknown, malformed and array credentials fail closed', () => {
  const authenticate = createAuthenticator(tokens)
  for (const headers of [
    {},
    { 'x-api-key': '' },
    { 'x-api-key': 'unknown' },
    { 'x-api-key': ['client-secret'] },
    { 'x-api-key': 'client-secret, client-secret' },
    { authorization: 'Basic client-secret' },
    { authorization: 'Bearer' },
    { authorization: 'Bearer client-secret suffix' },
    { authorization: 'Bearer client-secret\n' },
    { authorization: ['Bearer client-secret'] },
    { 'proxy-authorization': 'Bearer unknown' },
    { cookie: 'x-api-key=client-secret' },
  ]) {
    assert.equal(authenticate(request(headers)), null)
  }
})

test('apiKeyHelper may supply the same credential in multiple header names', () => {
  const authenticate = createAuthenticator(tokens)
  assert.equal(authenticate(request({
    'x-api-key': 'client-secret',
    authorization: 'Bearer client-secret',
    'proxy-authorization': 'Bearer client-secret',
  })), 'local')
})

test('conflicting or malformed credentials cannot fall back to a valid header', () => {
  const authenticate = createAuthenticator([
    ...tokens,
    { name: 'other', token: 'other-secret' },
  ])
  for (const headers of [
    { 'x-api-key': 'unknown', authorization: 'Bearer client-secret' },
    { 'x-api-key': 'client-secret', authorization: 'Bearer unknown' },
    { 'x-api-key': 'client-secret', authorization: 'Bearer other-secret' },
    { 'x-api-key': 'client-secret', authorization: 'Basic invalid' },
    { authorization: 'Bearer client-secret', 'proxy-authorization': 'Bearer other-secret' },
  ]) {
    assert.equal(authenticate(request(headers)), null)
  }
})

test('duplicate credentials are rejected even when Node discarded or joined a duplicate', () => {
  const authenticate = createAuthenticator(tokens)
  for (const rawHeaders of [
    ['x-api-key', 'client-secret', 'X-API-KEY', 'client-secret'],
    ['Authorization', 'Bearer client-secret', 'authorization', 'Bearer unknown'],
    ['Proxy-Authorization', 'Bearer client-secret', 'proxy-authorization', 'Bearer client-secret'],
  ]) {
    assert.equal(authenticate(request({ 'x-api-key': 'client-secret' }, rawHeaders)), null)
  }
  assert.equal(authenticate(request({ 'x-api-key': 'client-secret', 'X-Api-Key': 'client-secret' })), null)
})

test('raw headers are authoritative and permit one credential per field', () => {
  const authenticate = createAuthenticator(tokens)
  assert.equal(authenticate(request({}, [
    'Host', 'localhost',
    'X-API-Key', 'client-secret',
    'Authorization', 'Bearer client-secret',
  ])), 'local')
  assert.equal(authenticate(request({ 'x-api-key': 'client-secret' }, [
    'X-API-Key', 'unknown',
  ])), null)
  assert.equal(authenticate(request({ 'x-api-key': 'client-secret' }, ['X-API-Key'])), null)
})

test('authentication registries do not share state or retain mutable token entries', () => {
  const entries = [{ name: 'first', token: 'same-token' }]
  const first = createAuthenticator(entries)
  const second = createAuthenticator([{ name: 'second', token: 'same-token' }])
  entries[0].name = 'changed'
  entries[0].token = 'changed-token'
  assert.equal(first(request({ 'x-api-key': 'same-token' })), 'first')
  assert.equal(second(request({ 'x-api-key': 'same-token' })), 'second')
  assert.equal(first(request({ 'x-api-key': 'changed-token' })), null)
})

test('registry construction rejects duplicate tokens without exposing them', () => {
  assert.throws(() => createAuthenticator([
    { name: 'one', token: 'sensitive-client-secret' },
    { name: 'two', token: 'sensitive-client-secret' },
  ]), { message: 'Duplicate client token' })
})
