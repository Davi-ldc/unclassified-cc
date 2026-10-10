import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync,
  readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { parse, stringify } from 'yaml'
import {
  addInstallKey, applyInstall, InstallError, listInstallKeys, parseInstallArgs, parseServerEnv,
  parseServerKeys, preflightInstall, removeInstallKey, renderServerEnv, renderServerKeys,
  renderServiceUnit, type InstallOptions,
} from '../src/scripts/install.js'
import { createSetup, renderLauncher } from '../src/scripts/setup.js'

const KEY = 'dummy-install-key'
const ROTATED = 'dummy-rotation-key'
const SECOND = 'dummy-second-key'
const THIRD = 'dummy-third-key'
function fixture(t: TestContext, specialPaths = false) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-gateway-install-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = join(directory, specialPaths ? 'checkout with \'"$%\\ chars' : 'checkout')
  const home = join(directory, 'home')
  const base = join(directory, specialPaths ? 'config with \'"$%\\ chars' : 'config')
  for (const path of [root, home, join(root, 'dist')]) mkdirSync(path, { recursive: true, mode: 0o700 })
  const node = join(directory, 'node')
  writeFileSync(node, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  writeFileSync(join(root, 'dist/index.js'), '// fixture only\n', { mode: 0o600 })
  const unit = join(base, 'systemd/user/cc-gateway.service')
  const envFile = join(base, 'cc-gateway/server.env')
  const config = join(root, 'config.yaml')
  const command = join(home, '.local/bin/c')
  const launcher = join(root, 'clients/cc-local')
  const enabledLink = join(base, 'systemd/user/default.target.wants/cc-gateway.service')
  const state = {
    active: false, enabled: false, occupied: false, healthy: true, manager: true,
    failRestart: false, fragment: '', dropIns: '', onRestart: undefined as (() => void) | undefined,
  }
  const calls: string[][] = []
  const readiness: Array<{ origin: string; token: string }> = []
  const options: InstallOptions = {
    root, node, env: { HOME: home, XDG_CONFIG_HOME: base, PATH: '' },
    readinessAttempts: 1, readinessDelayMs: 0,
    adapters: {
      systemctl: async args => {
        calls.push([...args])
        if (args[0] === 'show' && args[1] !== 'cc-gateway.service') return { code: state.manager ? 0 : 1, stdout: '252\n' }
        if (args[0] === 'show') {
          const present = existsSync(unit)
          return { code: present ? 0 : 1, stdout: `LoadState=${present ? 'loaded' : 'not-found'}\nFragmentPath=${state.fragment || (present ? unit : '')}\nDropInPaths=${state.dropIns}\nActiveState=${state.active ? 'active' : 'inactive'}\nUnitFileState=${state.enabled ? 'enabled' : present ? 'disabled' : ''}\n` }
        }
        if (args[0] === 'enable') {
          state.enabled = true
          mkdirSync(dirname(enabledLink), { recursive: true, mode: 0o700 })
          if (!existsSync(enabledLink)) symlinkSync(unit, enabledLink)
        }
        if (args[0] === 'disable') {
          state.enabled = false
          try { unlinkSync(enabledLink) } catch {}
        }
        if (args[0] === 'restart') {
          state.onRestart?.()
          if (state.failRestart) return { code: 1, stdout: KEY }
          state.active = true
        }
        if (args[0] === 'stop') state.active = false
        return { code: 0, stdout: '' }
      },
      portAvailable: async () => !state.occupied,
      ready: async (origin, token) => { readiness.push({ origin, token }); return state.healthy },
    },
  }
  return { directory, root, home, base, node, unit, envFile, config, command, launcher, state, calls, readiness, options }
}
function tokenAt(config: string): string { return parse(readFileSync(config, 'utf8')).auth.tokens[0].token }
function mode(path: string): number { return lstatSync(path).mode & 0o777 }

test('fresh preflight is read-only and reports only whether a key is present', async t => {
  const f = fixture(t)
  const before = readdirSync(f.directory, { recursive: true })
  assert.equal(await preflightInstall(f.options), 'key-required')
  assert.deepEqual(readdirSync(f.directory, { recursive: true }), before)
  assert.ok(f.calls.every(call => call[0] === 'show'))
})

test('fresh installation keeps the upstream key separate and verifies the local profile', async t => {
  const f = fixture(t)
  await applyInstall(f.options, `${KEY}\n`)
  const token = tokenAt(f.config)
  assert.notEqual(token, KEY)
  assert.equal(parseServerEnv(readFileSync(f.envFile, 'utf8')), KEY)
  assert.ok(!readFileSync(f.config, 'utf8').includes(KEY))
  assert.equal(readFileSync(f.launcher, 'utf8'), renderLauncher(token, 'http://127.0.0.1:8443'))
  assert.equal(readlinkSync(f.command), f.launcher)
  assert.equal(mode(dirname(f.envFile)), 0o700)
  assert.equal(mode(f.envFile), 0o600)
  assert.equal(mode(f.unit), 0o644)
  assert.equal(mode(f.config), 0o600)
  assert.equal(mode(f.launcher), 0o700)
  assert.equal(f.state.active, true)
  assert.equal(f.state.enabled, true)
  assert.deepEqual(f.readiness, [{ origin: 'http://127.0.0.1:8443', token }])
  assert.ok(!JSON.stringify(f.calls).includes(KEY))
  assert.ok(!existsSync(join(f.home, '.claude')))
})

test('rerun reuses the key and token; rotation changes only the upstream credential', async t => {
  const f = fixture(t)
  await applyInstall(f.options, KEY)
  const config = readFileSync(f.config)
  const token = tokenAt(f.config)
  f.state.occupied = true
  assert.equal(await preflightInstall(f.options), 'key-present')
  await applyInstall(f.options, '')
  await applyInstall(f.options, ROTATED)
  assert.deepEqual(readFileSync(f.config), config)
  assert.equal(tokenAt(f.config), token)
  assert.equal(parseServerEnv(readFileSync(f.envFile, 'utf8')), ROTATED)
})

test('an owned c preserves its client name, and a missing launcher is recreated', async t => {
  const f = fixture(t)
  const launcher = createSetup(f.root, 'wsl')
  mkdirSync(dirname(f.command), { recursive: true, mode: 0o700 })
  symlinkSync(launcher, f.command)
  const token = tokenAt(f.config)
  unlinkSync(launcher)
  await applyInstall(f.options, KEY)
  assert.equal(readlinkSync(f.command), launcher)
  assert.equal(readFileSync(launcher, 'utf8'), renderLauncher(token, 'http://127.0.0.1:8443'))
  assert.equal(tokenAt(f.config), token)
  assert.ok(!existsSync(f.launcher))
})

test('existing configuration bytes, custom upstream and configured loopback port survive', async t => {
  const f = fixture(t)
  createSetup(f.root)
  const config = parse(readFileSync(f.config, 'utf8'))
  config.server.port = 9234
  config.upstream.url = 'https://example.invalid'
  const source = `# custom formatting stays\n${stringify(config)}`
  writeFileSync(f.config, source)
  writeFileSync(f.launcher, renderLauncher(config.auth.tokens[0].token, 'http://127.0.0.1:9234'))
  await applyInstall(f.options, KEY)
  assert.equal(readFileSync(f.config, 'utf8'), source)
  assert.equal(f.readiness[0].origin, 'http://127.0.0.1:9234')
})

test('quoted environment values round trip printable ASCII without shell interpretation', () => {
  const key = Array.from({ length: 94 }, (_, index) => String.fromCharCode(33 + index)).join('')
  assert.equal(parseServerEnv(renderServerEnv(key)), key)
  assert.equal(parseServerEnv(`CC_GATEWAY_UPSTREAM_API_KEY='${KEY}'\n`), KEY)
  assert.equal(parseServerEnv(`CC_GATEWAY_UPSTREAM_API_KEY=${KEY}\n`), KEY)
  for (const source of ['OTHER=x\n', 'CC_GATEWAY_UPSTREAM_API_KEY=x\nOTHER=y', 'CC_GATEWAY_UPSTREAM_API_KEY="unterminated', 'CC_GATEWAY_UPSTREAM_API_KEY="x\\n"', 'CC_GATEWAY_UPSTREAM_API_KEY=white space', 'CC_GATEWAY_UPSTREAM_API_KEY="x\r"']) {
    assert.throws(() => parseServerEnv(source), InstallError)
  }
})

test('systemd paths escape quotes, backslashes, dollars and percent specifiers', async t => {
  const f = fixture(t, true)
  await applyInstall(f.options, KEY)
  const unit = readFileSync(f.unit, 'utf8')
  assert.equal(unit, renderServiceUnit(f.root, f.node, f.envFile))
  assert.ok(unit.includes('%%'))
  assert.ok(unit.includes('$$'))
  assert.ok(unit.includes('\\"'))
  assert.ok(unit.includes('\\\\'))
  assert.equal(await preflightInstall(f.options), 'key-present')
})

test('generated units use unquoted directory settings that systemd accepts', t => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-gateway unit 100%-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = join(directory, 'checkout dir')
  const envFile = join(directory, 'config dir', 'server.env')
  mkdirSync(join(root, 'dist'), { recursive: true })
  mkdirSync(dirname(envFile), { recursive: true })
  for (const file of [join(root, 'dist/index.js'), join(root, 'config.yaml'), envFile]) writeFileSync(file, '')
  const unit = renderServiceUnit(root, process.execPath, envFile)
  // These two directives take the rest of the line as a path, so quotes would become part of it.
  assert.ok(unit.includes(`\nWorkingDirectory=${root.replaceAll('%', '%%')}\n`))
  assert.ok(unit.includes(`\nEnvironmentFile=${envFile.replaceAll('%', '%%')}\n`))
  assert.doesNotMatch(unit, /^(?:WorkingDirectory|EnvironmentFile)="/m)

  // The real analyzer is the authority; skip where it is missing or cannot load any unit.
  const probe = join(directory, 'probe.service')
  writeFileSync(probe, '[Service]\nExecStart=/bin/true\n')
  const works = spawnSync('systemd-analyze', ['--user', 'verify', probe], { encoding: 'utf8' })
  if (works.error || works.status !== 0) { t.skip('systemd-analyze is unavailable here'); return }
  const path = join(directory, 'cc-gateway.service')
  writeFileSync(path, unit)
  const result = spawnSync('systemd-analyze', ['--user', 'verify', path], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('foreign c, client launcher and unit are never overwritten', async t => {
  for (const target of ['command', 'launcher', 'unit'] as const) {
    const f = fixture(t)
    const path = f[target]
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, 'foreign state', { mode: 0o600 })
    await assert.rejects(applyInstall(f.options, KEY), InstallError)
    assert.equal(readFileSync(path, 'utf8'), 'foreign state')
    assert.equal(f.state.active, false)
  }
})

test('symlinked configuration, credential, unit and parent directory are refused', async t => {
  for (const target of ['config', 'envFile', 'unit', 'base'] as const) {
    const f = fixture(t)
    const foreign = join(f.directory, 'foreign')
    if (target === 'base') mkdirSync(foreign)
    else writeFileSync(foreign, 'foreign')
    mkdirSync(dirname(f[target]), { recursive: true, mode: 0o700 })
    symlinkSync(foreign, f[target])
    await assert.rejects(preflightInstall(f.options), InstallError)
    assert.ok(lstatSync(f[target]).isSymbolicLink())
  }
})

test('foreign command search paths and occupied ports fail before installation', async t => {
  const f = fixture(t)
  f.state.occupied = true
  await assert.rejects(preflightInstall(f.options), /occupied/)
  f.state.occupied = false
  const bin = join(f.directory, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'c'), '#!/bin/sh\n', { mode: 0o700 })
  f.options.env!.PATH = bin
  await assert.rejects(preflightInstall(f.options), /Another c command/)
  assert.ok(!existsSync(f.config))
})

test('occupied port requires the owned active unit and authenticated readiness', async t => {
  const f = fixture(t)
  await applyInstall(f.options, KEY)
  f.state.occupied = true
  f.state.active = false
  await assert.rejects(preflightInstall(f.options), /occupied/)
  f.state.active = true
  f.state.healthy = false
  await assert.rejects(preflightInstall(f.options), /occupied/)
  f.state.healthy = true
  assert.equal(await preflightInstall(f.options), 'key-present')
  f.state.fragment = '/foreign/cc-gateway.service'
  await assert.rejects(preflightInstall(f.options), /foreign/)
  f.state.fragment = ''
  f.state.dropIns = '/foreign/override.conf'
  await assert.rejects(preflightInstall(f.options), /override/)
})

test('failed initial activation restores files and service enablement', async t => {
  const f = fixture(t)
  f.state.failRestart = true
  await assert.rejects(applyInstall(f.options, KEY), /service operation failed/)
  for (const path of [f.config, f.envFile, f.unit, f.launcher, f.command]) assert.ok(!existsSync(path))
  assert.equal(f.state.active, false)
  assert.equal(f.state.enabled, false)
  assert.ok(!existsSync(join(f.root, 'config.yaml.lock')))
})

test('failed readiness restores prior bytes, permissions and the active service', async t => {
  const f = fixture(t)
  await applyInstall(f.options, KEY)
  chmodSync(f.envFile, 0o640)
  chmodSync(f.launcher, 0o500)
  const paths = [f.config, f.envFile, f.unit, f.launcher]
  const before = paths.map(path => ({ data: readFileSync(path), mode: mode(path) }))
  f.state.healthy = false
  f.calls.length = 0
  await assert.rejects(applyInstall(f.options, ROTATED), /readiness/)
  paths.forEach((path, index) => {
    assert.deepEqual(readFileSync(path), before[index].data)
    assert.equal(mode(path), before[index].mode)
  })
  assert.equal(readlinkSync(f.command), f.launcher)
  assert.equal(f.state.active, true)
  assert.equal(f.state.enabled, true)
  assert.equal(f.calls.filter(call => call[0] === 'restart').length, 2)
})

test('rollback leaves a concurrently replaced file intact', async t => {
  const f = fixture(t)
  f.state.onRestart = () => {
    const replacement = join(f.directory, 'replacement')
    writeFileSync(replacement, 'concurrent replacement', { mode: 0o600 })
    renameSync(replacement, f.envFile)
  }
  f.state.healthy = false
  await assert.rejects(applyInstall(f.options, KEY), /rollback was incomplete/)
  assert.equal(readFileSync(f.envFile, 'utf8'), 'concurrent replacement')
})

test('invalid secrets and adapter failures never echo credential or subprocess contents', async t => {
  const f = fixture(t)
  await assert.rejects(applyInstall(f.options, `${KEY}\nextra`), error => {
    assert.ok(error instanceof InstallError)
    assert.ok(!error.message.includes(KEY))
    return true
  })
  f.options.adapters!.systemctl = async () => { throw new Error(`raw subprocess secret ${KEY}`) }
  await assert.rejects(preflightInstall(f.options), error => {
    assert.ok(error instanceof InstallError)
    assert.ok(!error.message.includes(KEY))
    assert.ok(!error.message.includes('raw subprocess'))
    return true
  })
})

test('shared setup lock, missing manager, client-token keys and nonlocal binds are refused', async t => {
  const f = fixture(t)
  const lock = join(f.root, 'config.yaml.lock')
  writeFileSync(lock, 'another operation')
  await assert.rejects(applyInstall(f.options, KEY), /lock/)
  assert.equal(readFileSync(lock, 'utf8'), 'another operation')
  unlinkSync(lock)
  f.state.manager = false
  await assert.rejects(preflightInstall(f.options), /manager/)
  f.state.manager = true
  createSetup(f.root)
  await assert.rejects(applyInstall(f.options, tokenAt(f.config)), /configuration is invalid/)
  const config = parse(readFileSync(f.config, 'utf8'))
  config.server.host = '0.0.0.0'
  writeFileSync(f.config, stringify(config))
  await assert.rejects(preflightInstall(f.options), /loopback/)
})

test('CLI parsing accepts only the fixed commands, absolute paths and a one-digit key index', () => {
  assert.deepEqual(parseInstallArgs(['preflight', '--root', '/checkout', '--node', '/node']), { command: 'preflight', root: '/checkout', node: '/node' })
  assert.equal(parseInstallArgs(['apply', '--node', '/node', '--root', '/checkout']).command, 'apply')
  assert.deepEqual(parseInstallArgs(['list-keys', '--root', '/c', '--node', '/n']), { command: 'list-keys', root: '/c', node: '/n' })
  assert.deepEqual(parseInstallArgs(['add-key', '--root', '/c', '--node', '/n']), { command: 'add-key', root: '/c', node: '/n' })
  assert.deepEqual(parseInstallArgs(['remove-key', '--index', '2', '--root', '/c', '--node', '/n']), { command: 'remove-key', root: '/c', node: '/n', index: 2 })
  for (const args of [
    [], ['--help'], ['apply', '--root', '/x', '--root', '/y'], ['apply', '--root', 'relative', '--node', '/node'],
    ['apply', '--root', '/x\n', '--node', '/node'], ['apply', '--root', '/x', '--node', '/node', '--key', KEY],
    ['remove-key', '--root', '/c', '--node', '/n'], ['remove-key', '--index', '0', '--root', '/c', '--node', '/n'],
    ['remove-key', '--index', '9', '--root', '/c', '--node', '/n'], ['remove-key', '--index', '1.5', '--root', '/c', '--node', '/n'],
    ['remove-key', '--index', '-1', '--root', '/c', '--node', '/n'], ['remove-key', '--index', '10', '--root', '/c', '--node', '/n'],
    ['add-key', '--index', '1', '--root', '/c', '--node', '/n'], ['list-keys', '--root', '/c', '--node', '/n', 'extra'],
    ['add-key', '--root', '/c', '--node', '/n', '--api-key', KEY],
  ]) {
    assert.throws(() => parseInstallArgs(args), InstallError)
  }
})

const sealed = (f: ReturnType<typeof fixture>) => [f.config, f.launcher, f.unit].map(path => readFileSync(path))

test('keys are added in order, listed without values, and removed with the next key promoted', async t => {
  const f = fixture(t)
  await applyInstall(f.options, KEY)
  const stable = sealed(f)
  f.state.occupied = true
  f.calls.length = 0
  f.readiness.length = 0
  await addInstallKey(f.options, `${SECOND}\n`)
  await addInstallKey(f.options, THIRD)
  assert.deepEqual(parseServerKeys(readFileSync(f.envFile, 'utf8')), [KEY, SECOND, THIRD])
  const listed = await listInstallKeys(f.options)
  assert.deepEqual(listed, [{ index: 1, role: 'primary' }, { index: 2, role: 'fallback' }, { index: 3, role: 'fallback' }])
  assert.ok(!JSON.stringify(listed).includes(SECOND))
  await removeInstallKey(f.options, 1)
  assert.deepEqual(parseServerKeys(readFileSync(f.envFile, 'utf8')), [SECOND, THIRD])
  await removeInstallKey(f.options, 2)
  assert.deepEqual(parseServerKeys(readFileSync(f.envFile, 'utf8')), [SECOND])
  await assert.rejects(removeInstallKey(f.options, 1), /last API key/)
  await assert.rejects(removeInstallKey(f.options, 2), /out of range/)
  assert.deepEqual(parseServerKeys(readFileSync(f.envFile, 'utf8')), [SECOND])
  assert.equal(mode(f.envFile), 0o600)
  // Key edits touch only the credential file and restart the service; they never re-enable or rewrite it.
  assert.deepEqual(sealed(f), stable)
  assert.ok(f.calls.every(call => call[0] !== 'enable'))
  assert.ok(f.calls.some(call => call[0] === 'restart'))
  assert.ok(f.readiness.length > 0)
  assert.ok(!JSON.stringify(f.calls).includes(SECOND))
  assert.ok(!existsSync(join(f.root, 'config.yaml.lock')))
})

test('rotation keeps fallback keys while duplicate, malformed and oversized lists are refused', async t => {
  const f = fixture(t)
  await applyInstall(f.options, KEY)
  await addInstallKey(f.options, SECOND)
  await applyInstall(f.options, ROTATED)
  assert.deepEqual(parseServerKeys(readFileSync(f.envFile, 'utf8')), [ROTATED, SECOND])
  await applyInstall(f.options, '')
  assert.deepEqual(parseServerKeys(readFileSync(f.envFile, 'utf8')), [ROTATED, SECOND])
  const before = readFileSync(f.envFile)
  await assert.rejects(applyInstall(f.options, SECOND), /duplicated/)
  await assert.rejects(addInstallKey(f.options, ROTATED), /duplicated/)
  for (const bad of ['', 'has space', 'tab\tkey', 'new\nline']) {
    await assert.rejects(addInstallKey(f.options, bad), error => {
      assert.ok(error instanceof InstallError)
      assert.match(error.message, /printable/)
      assert.ok(!error.message.includes('has space'))
      return true
    })
  }
  assert.deepEqual(readFileSync(f.envFile), before)
  for (let index = 3; index <= 8; index++) await addInstallKey(f.options, `dummy-key-${index}`)
  assert.equal((await listInstallKeys(f.options)).length, 8)
  await assert.rejects(addInstallKey(f.options, 'dummy-key-9'), /between one and eight/)
  assert.equal((await listInstallKeys(f.options)).length, 8)
})

test('key management needs a managed installation and rolls back a failed readiness check', async t => {
  const fresh = fixture(t)
  await assert.rejects(addInstallKey(fresh.options, KEY), /existing managed installation/)
  await assert.rejects(listInstallKeys(fresh.options), /existing managed installation/)
  await assert.rejects(removeInstallKey(fresh.options, 1), /existing managed installation/)
  for (const path of [fresh.config, fresh.envFile, fresh.unit, fresh.command]) assert.ok(!existsSync(path))
  assert.ok(!existsSync(join(fresh.root, 'config.yaml.lock')))

  const f = fixture(t)
  await applyInstall(f.options, KEY)
  const env = readFileSync(f.envFile)
  f.state.healthy = false
  f.calls.length = 0
  await assert.rejects(addInstallKey(f.options, SECOND), /readiness/)
  assert.deepEqual(readFileSync(f.envFile), env)
  assert.equal(mode(f.envFile), 0o600)
  assert.equal(f.state.active, true)
  assert.equal(f.state.enabled, true)
  assert.equal(f.calls.filter(call => call[0] === 'restart').length, 2)
  f.state.healthy = true
  await addInstallKey(f.options, SECOND)
  f.state.healthy = false
  await assert.rejects(removeInstallKey(f.options, 2), /readiness/)
  assert.deepEqual(parseServerKeys(readFileSync(f.envFile, 'utf8')), [KEY, SECOND])
})

test('fallback credential lists round trip and unsupported shapes are refused', () => {
  const keys = ['primary-key-1', 'a"b$c`d\\e', 'third-key-3']
  const source = renderServerKeys(keys)
  assert.ok(source.startsWith('# Managed by cc-gateway installer.\n'))
  assert.deepEqual(parseServerKeys(source), keys)
  assert.deepEqual(parseServerKeys(renderServerKeys(['only'])), ['only'])
  assert.ok(!renderServerKeys(['only']).includes('CC_GATEWAY_FALLBACK_API_KEYS'))
  const quoted = (value: string) => `"${value.replace(/[\\"$`]/g, '\\$&')}"`
  const withFallbacks = (value: string) => `CC_GATEWAY_UPSTREAM_API_KEY=a\nCC_GATEWAY_FALLBACK_API_KEYS=${quoted(value)}\n`
  for (const bad of [
    withFallbacks('not-json'), withFallbacks('{"x":1}'), withFallbacks('["a"]'), withFallbacks('[1]'),
    withFallbacks('["has space"]'), withFallbacks('[""]'), withFallbacks('["b","b"]'),
    withFallbacks(JSON.stringify(Array.from({ length: 8 }, (_, index) => `k${index}`))),
    `CC_GATEWAY_UPSTREAM_API_KEY=a\nCC_GATEWAY_FALLBACK_API_KEYS=${quoted('["b"]')}\nCC_GATEWAY_FALLBACK_API_KEYS=${quoted('["c"]')}\n`,
    `CC_GATEWAY_FALLBACK_API_KEYS=${quoted('["b"]')}\n`,
    `CC_GATEWAY_UPSTREAM_API_KEY=a\nCC_GATEWAY_UPSTREAM_API_KEY=b\n`,
    `CC_GATEWAY_UPSTREAM_API_KEY=a\nCC_GATEWAY_FALLBACK_API_KEYS=["b"]\n`,
  ]) assert.throws(() => parseServerKeys(bad), InstallError)
  assert.deepEqual(parseServerKeys(withFallbacks(JSON.stringify(Array.from({ length: 7 }, (_, index) => `k${index}`)))).length, 8)
  assert.throws(() => renderServerKeys([]), InstallError)
  assert.throws(() => renderServerKeys(['a', 'a']), InstallError)
  assert.throws(() => renderServerKeys(Array.from({ length: 9 }, (_, index) => `k${index}`)), InstallError)
})

function legacyUnit(f: ReturnType<typeof fixture>): string {
  return `[Unit]\nDescription=Local Claude Code privacy gateway\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${f.root}\nEnvironmentFile=${f.envFile}\nEnvironment=NODE_TLS_REJECT_UNAUTHORIZED=1\nExecStart=/usr/local/bin/node ${f.root}/dist/index.js ${f.config}\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=10\nUMask=0077\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`
}
function legacyInstall(f: ReturnType<typeof fixture>): string {
  const launcher = createSetup(f.root, 'wsl')
  mkdirSync(dirname(f.command), { recursive: true, mode: 0o700 })
  symlinkSync(launcher, f.command)
  mkdirSync(dirname(f.envFile), { recursive: true, mode: 0o700 })
  writeFileSync(f.envFile, `CC_GATEWAY_UPSTREAM_API_KEY=${KEY}\n`, { mode: 0o600 })
  mkdirSync(dirname(f.unit), { recursive: true, mode: 0o700 })
  writeFileSync(f.unit, legacyUnit(f), { mode: 0o644 })
  const link = join(dirname(f.unit), 'default.target.wants/cc-gateway.service')
  mkdirSync(dirname(link), { recursive: true, mode: 0o700 })
  symlinkSync(f.unit, link)
  f.state.active = true
  f.state.enabled = true
  f.state.occupied = true
  return launcher
}

test('a legacy installation is adopted with its client name, token, key and configuration bytes', async t => {
  const f = fixture(t)
  const launcher = legacyInstall(f)
  const token = tokenAt(f.config)
  const config = readFileSync(f.config)
  assert.equal(await preflightInstall(f.options), 'key-present')
  await applyInstall(f.options, '')
  assert.deepEqual(readFileSync(f.config), config)
  assert.equal(tokenAt(f.config), token)
  assert.equal(readlinkSync(f.command), launcher)
  assert.equal(readFileSync(f.unit, 'utf8'), renderServiceUnit(f.root, f.node, f.envFile))
  assert.ok(readFileSync(f.envFile, 'utf8').startsWith('# Managed by cc-gateway installer.\n'))
  assert.deepEqual(parseServerKeys(readFileSync(f.envFile, 'utf8')), [KEY])
  assert.equal(mode(f.envFile), 0o600)
  assert.equal(f.state.active, true)
  assert.equal(f.state.enabled, true)
  assert.ok(f.readiness.every(entry => entry.token === token))
  assert.ok(!existsSync(join(f.home, '.claude')))
})

test('a failed legacy upgrade restores the legacy unit, key file and running service', async t => {
  const f = fixture(t)
  legacyInstall(f)
  const unit = readFileSync(f.unit)
  const env = readFileSync(f.envFile)
  f.state.healthy = true
  f.state.onRestart = () => { f.state.healthy = false }
  await assert.rejects(applyInstall(f.options, ROTATED), /readiness/)
  assert.deepEqual(readFileSync(f.unit), unit)
  assert.deepEqual(readFileSync(f.envFile), env)
  assert.equal(f.state.active, true)
  assert.equal(f.state.enabled, true)
})

test('customized or near-legacy units are never adopted', async t => {
  for (const edit of [
    (source: string) => source.replace('Restart=on-failure', 'Restart=always'),
    (source: string) => source.replace('/usr/local/bin/node', '/opt/other/node'),
    (source: string) => source.replace('After=network-online.target', 'After=network.target'),
    (source: string) => source.replace('UMask=0077', 'UMask=0022'),
    (source: string) => `${source}ExecStartPre=/bin/true\n`,
    (source: string) => source.replace('[Install]', 'Environment=EXTRA=1\n\n[Install]'),
    (source: string) => source.replace('NODE_TLS_REJECT_UNAUTHORIZED=1', 'NODE_TLS_REJECT_UNAUTHORIZED=0'),
  ]) {
    const f = fixture(t)
    legacyInstall(f)
    const edited = edit(legacyUnit(f))
    writeFileSync(f.unit, edited)
    await assert.rejects(preflightInstall(f.options), /unrecognized gateway service/)
    await assert.rejects(applyInstall(f.options, ''), /unrecognized gateway service/)
    assert.equal(readFileSync(f.unit, 'utf8'), edited)
  }
})

test('a rerun adopts a relocated Node runtime inside its own unit', async t => {
  const f = fixture(t)
  await applyInstall(f.options, KEY)
  const moved = join(f.directory, 'other node "$%\\ runtime')
  writeFileSync(moved, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  f.options.node = moved
  assert.equal(await preflightInstall(f.options), 'key-present')
  await applyInstall(f.options, '')
  assert.equal(readFileSync(f.unit, 'utf8'), renderServiceUnit(f.root, moved, f.envFile))
  assert.ok(readFileSync(f.unit, 'utf8').includes('Environment=NODE_TLS_REJECT_UNAUTHORIZED=1\n'))
  const edited = readFileSync(f.unit, 'utf8').replace('Restart=on-failure', 'Restart=always')
  writeFileSync(f.unit, edited)
  await assert.rejects(preflightInstall(f.options), /unrecognized gateway service/)
  assert.equal(readFileSync(f.unit, 'utf8'), edited)
})

test('launcher revisions are upgraded in place, while a launcher with another token is refused', async t => {
  const f = fixture(t)
  await applyInstall(f.options, KEY)
  const token = tokenAt(f.config)
  const older = readFileSync(f.launcher, 'utf8').replace('exec claude "$@"', 'exec claude --older-revision "$@"')
  writeFileSync(f.launcher, older)
  await applyInstall(f.options, '')
  assert.equal(readFileSync(f.launcher, 'utf8'), renderLauncher(token, 'http://127.0.0.1:8443'))
  assert.equal(mode(f.launcher), 0o700)
  const foreign = older.replace(token, 'another-token')
  writeFileSync(f.launcher, foreign)
  await assert.rejects(applyInstall(f.options, ''), /unrecognized client launcher/)
  assert.equal(readFileSync(f.launcher, 'utf8'), foreign)
})

test('PATH entries that cannot hold a command are not treated as conflicts', async t => {
  const f = fixture(t)
  const file = join(f.directory, 'plain-file')
  writeFileSync(file, 'not a directory')
  f.options.env!.PATH = [join(f.directory, 'missing'), join(file, 'nested')].join(':')
  assert.equal(await preflightInstall(f.options), 'key-required')
  assert.ok(!existsSync(f.config))
})
