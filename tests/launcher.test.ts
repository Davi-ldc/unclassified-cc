import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { parse } from 'yaml'
import { addClient, createSetup, refreshClient, renderLauncher } from '../src/scripts/setup.js'

const flags = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
  CLAUDE_CODE_DISABLE_FAST_MODE: '1',
  CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1',
  CLAUDE_CODE_GATEWAY_HINT_HEADERS: '0',
  CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
}
const cleared = [
  'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CC_GATEWAY_UPSTREAM_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_ENABLE_TELEMETRY', 'NODE_TLS_REJECT_UNAUTHORIZED',
]

function fixture(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'cc-gateway-launcher-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

function config(directory: string) {
  return parse(readFileSync(join(directory, 'config.yaml'), 'utf8')) as {
    server: { host: string; port: number }
    upstream: { url: string; user_agent: string; api_key?: string }
    auth: { tokens: { name: string; token: string }[] }
  }
}

function fakeClaude(directory: string): NodeJS.ProcessEnv {
  const bin = join(directory, 'bin')
  mkdirSync(bin)
  const keys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', ...Object.keys(flags), ...cleared]
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const keys = ${JSON.stringify(keys)}
if (process.argv.includes('--wait-for-signal')) {
  process.on('SIGTERM', () => process.exit(23))
  setInterval(() => {}, 1000)
}
console.log(JSON.stringify({pid: process.pid, args: process.argv.slice(2), cwd: process.cwd(), env: Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]))}))
`, { mode: 0o700 })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: directory,
    // An inherited native profile must be replaced, never reused.
    CLAUDE_CONFIG_DIR: join(directory, '.claude'),
    XDG_DATA_HOME: join(directory, '.local/share'),
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    ANTHROPIC_API_KEY: 'unrelated-api-key',
    ANTHROPIC_BASE_URL: 'https://unrelated.example',
  }
  for (const name of cleared) env[name] = 'inherited-value-must-not-reach-claude'
  env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  return env
}

test('setup creates private API-key configuration and a client launcher without storing an upstream key', t => {
  const directory = fixture(t)
  const launcher = createSetup(directory, 'laptop')
  const parsed = config(directory)
  assert.equal(parsed.server.host, '127.0.0.1')
  assert.equal(parsed.upstream.user_agent, 'opencode/1.18.35')
  assert.equal(parsed.upstream.api_key, undefined)
  assert.equal(parsed.auth.tokens.length, 1)
  assert.equal(parsed.auth.tokens[0].name, 'laptop')
  assert.match(parsed.auth.tokens[0].token, /^[a-f0-9]{64}$/)
  assert.deepEqual(Object.keys(parsed).sort(), ['auth', 'logging', 'server', 'upstream'])
  assert.equal(statSync(join(directory, 'config.yaml')).mode & 0o777, 0o600)
  assert.equal(statSync(join(directory, 'clients')).mode & 0o777, 0o700)
  assert.equal(statSync(launcher).mode & 0o777, 0o700)
  assert.equal(existsSync(join(directory, 'config.yaml.lock')), false)
})

test('launcher preserves arguments, cwd and process identity while removing inherited credentials', t => {
  const directory = fixture(t)
  const launcher = createSetup(directory, 'laptop')
  const cwd = join(directory, "project with 'quotes' and $symbols")
  mkdirSync(cwd)
  const args = ['--print', 'literal $(touch ignored) "quote"', '--resume', 'session value']
  const child = spawnSync(launcher, args, { cwd, env: fakeClaude(directory), encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  const captured = JSON.parse(child.stdout)
  assert.equal(captured.pid, child.pid)
  assert.deepEqual(captured.args, args)
  assert.equal(captured.cwd, cwd)
  assert.equal(captured.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8443/agent-v2')
  assert.equal(captured.env.CLAUDE_CONFIG_DIR, join(directory, '.local/share/cc-gateway/claude'))
  assert.equal(captured.env.ANTHROPIC_API_KEY, config(directory).auth.tokens[0].token)
  for (const [name, value] of Object.entries(flags)) assert.equal(captured.env[name], value, name)
  for (const name of cleared) assert.equal(captured.env[name], null, name)
  assert.equal(existsSync(join(cwd, 'ignored')), false)
})

test('launcher exec passes termination directly to Claude', { timeout: 5000 }, async t => {
  const directory = fixture(t)
  const launcher = createSetup(directory)
  const child = spawn(launcher, ['--wait-for-signal'], {
    cwd: directory,
    env: fakeClaude(directory),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => { child.kill('SIGKILL') })
  const [output] = await once(child.stdout, 'data')
  assert.equal(JSON.parse(String(output)).pid, child.pid)
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const [code, signal] = await exited
  assert.equal(code, 23)
  assert.equal(signal, null)
})

test('launcher quotes tokens and validates HTTPS without disabling certificate checks', t => {
  const directory = fixture(t)
  const token = "credential'$(printf${IFS}not-executed)"
  const launcher = join(directory, 'client')
  writeFileSync(launcher, renderLauncher(token, 'https://gateway.example:9443/'), { mode: 0o700 })
  assert.equal(spawnSync('bash', ['-n', launcher]).status, 0)
  const child = spawnSync(launcher, [], { cwd: directory, env: fakeClaude(directory), encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  const captured = JSON.parse(child.stdout)
  assert.equal(captured.env.ANTHROPIC_API_KEY, token)
  assert.equal(captured.env.ANTHROPIC_BASE_URL, 'https://gateway.example:9443/agent-v2')
  assert.equal(captured.env.NODE_TLS_REJECT_UNAUTHORIZED, null)
  // A token whose suffix is not plain text is never embedded in seeded JSON.
  assert.equal(existsSync(join(directory, '.local/share/cc-gateway/claude/.claude.json')), false)
})

test('adding a client preserves existing configuration and comments', t => {
  const directory = fixture(t)
  createSetup(directory, 'first')
  const path = join(directory, 'config.yaml')
  writeFileSync(path, `# Keep this operational note\n${readFileSync(path, 'utf8')}`)
  const originalToken = config(directory).auth.tokens[0].token
  const launcher = addClient(directory, 'second', 'https://gateway.example')
  const parsed = config(directory)
  assert.deepEqual(parsed.auth.tokens.map(entry => entry.name), ['first', 'second'])
  assert.equal(parsed.auth.tokens[0].token, originalToken)
  assert.notEqual(parsed.auth.tokens[1].token, originalToken)
  assert.match(readFileSync(path, 'utf8'), /^# Keep this operational note/)
  assert.match(readFileSync(launcher, 'utf8'), /https:\/\/gateway\.example/)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(existsSync(join(directory, 'config.yaml.lock')), false)
})

test('setup refuses to replace existing configuration or launchers', t => {
  const directory = fixture(t)
  const launcher = createSetup(directory, 'first')
  const path = join(directory, 'config.yaml')
  const originalConfig = readFileSync(path, 'utf8')
  const originalLauncher = readFileSync(launcher, 'utf8')
  assert.throws(() => createSetup(directory, 'second'), /already exists/)
  assert.throws(() => addClient(directory, 'first'), /already exists/)
  assert.equal(readFileSync(path, 'utf8'), originalConfig)
  assert.equal(readFileSync(launcher, 'utf8'), originalLauncher)
  assert.equal(existsSync(join(directory, 'clients', 'cc-second')), false)
})

test('launcher collision leaves client configuration unchanged', t => {
  const directory = fixture(t)
  createSetup(directory, 'first')
  const path = join(directory, 'config.yaml')
  const source = readFileSync(path, 'utf8')
  const launcher = join(directory, 'clients', 'cc-second')
  writeFileSync(launcher, 'existing launcher', { mode: 0o700 })
  assert.throws(() => addClient(directory, 'second'), /EEXIST/)
  assert.equal(readFileSync(path, 'utf8'), source)
  assert.equal(readFileSync(launcher, 'utf8'), 'existing launcher')
  assert.equal(readdirSync(join(directory, 'clients')).some(name => name.endsWith('.tmp')), false)
  assert.equal(existsSync(join(directory, 'config.yaml.lock')), false)
})

test('setup never follows a config symlink', t => {
  const directory = fixture(t)
  const target = join(directory, 'untouched')
  writeFileSync(target, 'leave this content alone')
  symlinkSync(target, join(directory, 'config.yaml'))
  assert.throws(() => createSetup(directory), /already exists/)
  assert.throws(() => addClient(directory, 'new'), /regular file/)
  assert.equal(readFileSync(target, 'utf8'), 'leave this content alone')
})

test('setup refuses symlinked launcher directories and concurrent setup locks', t => {
  const directory = fixture(t)
  const outside = join(directory, 'other')
  mkdirSync(outside)
  symlinkSync(outside, join(directory, 'clients'))
  assert.throws(() => createSetup(directory), /real directories/)
  assert.equal(existsSync(join(directory, 'config.yaml')), false)
  assert.deepEqual(readdirSync(outside), [])
  writeFileSync(join(directory, 'config.yaml.lock'), '')
  assert.throws(() => createSetup(directory), /locked/)
  assert.equal(existsSync(join(directory, 'config.yaml.lock')), true)
})

test('setup validates client names and gateway destinations before writing credentials', t => {
  const directory = fixture(t)
  createSetup(directory, 'first')
  const before = readFileSync(join(directory, 'config.yaml'), 'utf8')
  for (const name of ['../outside', '.', '', 'name with spaces', '-option']) {
    assert.throws(() => addClient(directory, name), /Client name/)
  }
  for (const url of ['http://remote.example', 'https://user:pass@gateway.example', 'https://gateway.example/path', 'https://gateway.example?token=private', 'file:///tmp/gateway', 'https://gateway.example\n']) {
    assert.throws(() => addClient(directory, 'second', url), /Gateway URL|Remote gateways/)
  }
  assert.equal(readFileSync(join(directory, 'config.yaml'), 'utf8'), before)
  assert.equal(existsSync(join(directory, 'clients', 'cc-second')), false)
})

test('gateway sessions use a dedicated seeded profile and never touch native Claude state', t => {
  const directory = fixture(t)
  const launcher = createSetup(directory)
  const token = config(directory).auth.tokens[0].token
  const env = fakeClaude(directory)
  const native = join(directory, '.claude')
  mkdirSync(native)
  writeFileSync(join(native, 'memory.txt'), 'keep-existing-state')
  writeFileSync(join(directory, '.claude.json'), 'keep-native-global-config')
  const profile = join(directory, '.local/share/cc-gateway/claude')

  const first = spawnSync(launcher, [], { cwd: directory, env, encoding: 'utf8' })
  assert.equal(first.status, 0, first.stderr)
  assert.equal(JSON.parse(first.stdout).env.CLAUDE_CONFIG_DIR, profile)
  assert.equal(statSync(profile).mode & 0o777, 0o700)
  const seeded = join(profile, '.claude.json')
  assert.equal(statSync(seeded).mode & 0o777, 0o600)
  // Only the last 20 characters of the gateway token are recorded, never the whole credential.
  assert.deepEqual(JSON.parse(readFileSync(seeded, 'utf8')), {
    hasCompletedOnboarding: true,
    customApiKeyResponses: { approved: [token.slice(-20)], rejected: [] },
  })
  assert.equal(readFileSync(seeded, 'utf8').includes(token), false)

  // An existing profile file belongs to the CLI and is never rewritten.
  writeFileSync(seeded, '{"hasCompletedOnboarding":true,"custom":"kept"}\n')
  assert.equal(spawnSync(launcher, [], { cwd: directory, env }).status, 0)
  assert.equal(readFileSync(seeded, 'utf8'), '{"hasCompletedOnboarding":true,"custom":"kept"}\n')

  // The native profile and its global configuration stay untouched.
  assert.equal(readFileSync(join(native, 'memory.txt'), 'utf8'), 'keep-existing-state')
  assert.equal(readFileSync(join(directory, '.claude.json'), 'utf8'), 'keep-native-global-config')

  const custom = join(directory, 'custom-profile')
  const chosen = spawnSync(launcher, [], { cwd: directory, env: { ...env, CC_GATEWAY_CLAUDE_CONFIG_DIR: custom }, encoding: 'utf8' })
  assert.equal(chosen.status, 0, chosen.stderr)
  assert.equal(JSON.parse(chosen.stdout).env.CLAUDE_CONFIG_DIR, custom)
  assert.equal(existsSync(join(custom, '.claude.json')), true)
  const relative = spawnSync(launcher, [], { cwd: directory, env: { ...env, CC_GATEWAY_CLAUDE_CONFIG_DIR: 'relative/profile' }, encoding: 'utf8' })
  assert.equal(relative.status, 1)
  assert.match(relative.stderr, /absolute path/)
})

test('refresh-client updates only a recognized launcher and preserves its token', t => {
  const directory = fixture(t)
  const launcher = createSetup(directory, 'first')
  const before = readFileSync(join(directory, 'config.yaml'), 'utf8')
  writeFileSync(launcher, readFileSync(launcher, 'utf8').replace('8443/agent-v2', '8443/agent'))
  assert.equal(refreshClient(directory, 'first'), launcher)
  assert.match(readFileSync(launcher, 'utf8'), /8443\/agent-v2/)
  assert.equal(readFileSync(join(directory, 'config.yaml'), 'utf8'), before)
  writeFileSync(launcher, '#!/bin/sh\nexit 0\n')
  assert.throws(() => refreshClient(directory, 'first'), /unrecognized/)
  assert.equal(readFileSync(launcher, 'utf8'), '#!/bin/sh\nexit 0\n')
})

test('Docker setup uses an explicit container bind and private host-loopback launcher', t => {
  const directory = fixture(t)
  const launcher = createSetup(directory, 'docker', true)
  assert.equal(config(directory).server.host, '0.0.0.0')
  assert.match(readFileSync(launcher, 'utf8'), /http:\/\/127\.0\.0\.1:8443/)
})
