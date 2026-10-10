import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  KEY, RUNTIMES, SECOND_KEY, assertNoKeyLeak, createFixture, fakeBinaryText,
  type InstallFixture, type RuntimeKey,
} from './install-support.js'

// Everything here runs against copies of the shell scripts, fake Bun/Node/systemctl/claude
// and download tools, temporary HOME/XDG roots and dummy keys. No real installer, download,
// service or paid API call is involved. The hidden terminal prompt needs a pty and is not
// covered; the stdin and environment paths are.

const INSTALL = 'install --frozen-lockfile --ignore-scripts'
const BUILD = 'run build'
const ALLOWED_ENV = new Set([
  'HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_COLLATE',
  'LC_NUMERIC', 'LC_TIME', 'LC_MONETARY', 'TERM', 'TMPDIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  // Variables Bash itself exports to every child.
  '_', 'PWD', 'OLDPWD', 'SHLVL',
])

function noMutation(f: InstallFixture): void {
  assert.deepEqual(f.steps(), [], 'no install, build or helper step may run')
  assert.equal(existsSync(join(f.data, 'cc-gateway')), false, 'no runtime directory may be created')
  assert.equal(existsSync(join(f.home, '.local')), false, 'no launcher directory may be created')
}

function helperCall(f: InstallFixture, action: string) {
  return f.calls('bun').find(call => call.helper?.action === action)
}

function provisioning(f: InstallFixture): void {
  f.removeTool('bun')
  f.removeTool('node')
  for (const tool of ['curl', 'unzip', 'tar', 'xz'] as const) f.addTool(tool)
}

// ---------------------------------------------------------------- arguments

test('--help prints the usage without running a tool, touching the filesystem or reading a key', t => {
  const f = createFixture(t)
  const run = f.inner(['--help'], { env: { CC_GATEWAY_UPSTREAM_API_KEY: KEY } })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /Usage: source \.\/install\.sh \[--reuse-key \| --api-key-stdin\]/)
  assert.match(run.stdout, /--add-key/)
  assert.match(run.stdout, /--list-keys/)
  assert.match(run.stdout, /--remove-key N/)
  assert.deepEqual(f.calls(), [])
  assert.equal(existsSync(join(f.home, '.local')), false)
  assertNoKeyLeak(f, run)
})

const rejected: Array<[string, string[], RegExp]> = [
  ['an unknown option', ['--bogus'], /Unsupported option/],
  ['an API key as an option value', ['--api-key', KEY], /Unsupported option/],
  ['an API key as a bare argument', [KEY], /Unsupported option/],
  ['--help combined with another option', ['--help', '--reuse-key'], /Unsupported option/],
  ['two key input options', ['--reuse-key', '--api-key-stdin'], /Choose one key input option/],
  ['a repeated key input option', ['--reuse-key', '--reuse-key'], /Choose one key input option/],
  ['two key management actions', ['--list-keys', '--add-key'], /Choose one key management action/],
  ['a repeated key management action', ['--add-key', '--add-key'], /Choose one key management action/],
  ['--add-key with --reuse-key', ['--add-key', '--reuse-key'], /cannot be combined/],
  ['--reuse-key before --add-key', ['--reuse-key', '--add-key'], /cannot be combined/],
  ['--list-keys with --reuse-key', ['--list-keys', '--reuse-key'], /cannot be combined/],
  ['--list-keys with --api-key-stdin', ['--list-keys', '--api-key-stdin'], /cannot be combined/],
  ['--remove-key with --api-key-stdin', ['--remove-key', '2', '--api-key-stdin'], /cannot be combined/],
  ['--remove-key without an index', ['--remove-key'], /positive key index/],
  ['--remove-key 0', ['--remove-key', '0'], /positive key index/],
  ['--remove-key with a negative index', ['--remove-key', '-1'], /positive key index/],
  ['--remove-key with a non-number', ['--remove-key', 'abc'], /positive key index/],
  ['--remove-key with a leading zero', ['--remove-key', '01'], /positive key index/],
]
for (const [name, args, pattern] of rejected) {
  test(`rejects ${name} before any side effect`, t => {
    const f = createFixture(t)
    const run = f.inner(args, { input: KEY })
    assert.equal(run.status, 2, run.stderr)
    assert.match(run.stderr, pattern)
    assert.equal(run.stdout, '')
    assert.deepEqual(f.calls(), [])
    assertNoKeyLeak(f, run)
  })
}

// ------------------------------------------------------------ prerequisites

test('a relative HOME is refused', t => {
  const f = createFixture(t)
  const run = f.inner(['--api-key-stdin'], { input: KEY, env: { HOME: 'relative/home' } })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /HOME must be an absolute path/)
  assert.deepEqual(f.steps(), [])
  assertNoKeyLeak(f, run)
})

test('a non-Linux host is refused before any install step', t => {
  const f = createFixture(t)
  f.setControl({ uname: { s: 'Darwin' } })
  const run = f.inner(['--api-key-stdin'], { input: KEY })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /requires Linux or WSL with systemd/)
  noMutation(f)
  assertNoKeyLeak(f, run)
})

test('an unsupported CPU architecture is refused before any install step', t => {
  const f = createFixture(t)
  f.setControl({ uname: { m: 'riscv64' } })
  const run = f.inner(['--api-key-stdin'], { input: KEY })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /Supported runtime architectures are x86_64 and aarch64/)
  noMutation(f)
  assertNoKeyLeak(f, run)
})

test('a missing official claude command is refused without installing or signing in', t => {
  const f = createFixture(t)
  f.removeTool('claude')
  const run = f.inner(['--api-key-stdin'], { input: KEY })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /Install the official Claude Code CLI first/)
  noMutation(f)
  assertNoKeyLeak(f, run)
})

test('an unreachable systemd user manager is refused', t => {
  const f = createFixture(t)
  f.setControl({ systemctlFail: true })
  const run = f.inner(['--api-key-stdin'], { input: KEY })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /Cannot reach your systemd user manager/)
  noMutation(f)
  assertNoKeyLeak(f, run)
})

test('a missing systemctl is reported by name', t => {
  const f = createFixture(t)
  f.removeTool('systemctl')
  const run = f.inner(['--api-key-stdin'], { input: KEY })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /Required tool is missing: systemctl/)
  noMutation(f)
})

// ------------------------------------------------------------- install flow

test('fresh install runs locked install, build, preflight, then apply with the key only on stdin', t => {
  const f = createFixture(t)
  f.setControl({ bun: { preflight: 'key-required' } })
  const run = f.inner(['--api-key-stdin'], { input: `${KEY}\n` })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(f.steps(), [INSTALL, BUILD, 'preflight', 'apply'])
  assert.match(run.stdout, /cc-gateway is ready\. Run: c/)
  assert.match(run.stdout, /systemctl --user status cc-gateway\.service/)
  assert.match(run.stdout, /journalctl --user -u cc-gateway\.service -f/)

  const [install, build, preflight, apply] = f.calls('bun').filter(call => call.argv[0] !== '--version')
  for (const call of [install, build, preflight, apply]) {
    assert.equal(call.noEnvFile, true, 'Bun must ignore project .env files')
  }
  for (const call of [install, build]) assert.equal(call.cwd, f.repo)
  assert.equal(install.path.split(':')[0], f.tools, 'the chosen runtimes lead PATH for the build')
  for (const call of [install, build, preflight]) assert.equal(call.stdinKind, 'char', 'only apply may read stdin')
  assert.equal(apply.stdinKind, 'pipe')
  assert.equal(apply.stdin, `${KEY}\n`)
  for (const call of [preflight, apply]) {
    assert.equal(call.args?.[0], join(f.repo, 'src', 'scripts', 'install.ts'))
    assert.equal(call.helper?.root, f.repo)
    assert.equal(call.helper?.node, join(f.tools, 'node'))
  }
  assert.deepEqual(f.calls('curl'), [], 'compatible runtimes on PATH must not be downloaded')
  assert.equal(existsSync(join(f.data, 'cc-gateway')), false)
  assertNoKeyLeak(f, run)
})

test('a key exported in the environment is used without a prompt and never forwarded as an environment value', t => {
  const f = createFixture(t)
  const run = f.inner([], { env: { CC_GATEWAY_UPSTREAM_API_KEY: KEY } })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(f.steps(), [INSTALL, BUILD, 'preflight', 'apply'])
  assert.equal(helperCall(f, 'apply')?.stdin, KEY)
  assert.doesNotMatch(run.stdout + run.stderr, /Upstream API key/)
  assertNoKeyLeak(f, run)
})

test('build and helper processes run with an allowlisted environment', t => {
  const f = createFixture(t)
  const secrets = {
    ANTHROPIC_API_KEY: 'anthropic-secret-value',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret-value',
    GITHUB_TOKEN: 'github-secret-value',
    NODE_OPTIONS: '--no-warnings',
    BUN_CONFIG_REGISTRY: 'https://registry.invalid/',
    CC_GATEWAY_FALLBACK_API_KEYS: '["fallback"]',
    CC_GATEWAY_UPSTREAM_API_KEY: KEY,
  }
  const run = f.inner([], { env: secrets })
  assert.equal(run.status, 0, run.stderr)
  const calls = f.calls()
  assert.ok(calls.length > 0)
  for (const call of calls) {
    for (const name of Object.keys(secrets)) assert.ok(!call.envNames.includes(name), `${call.tool} must not receive ${name}`)
    for (const name of call.envNames) assert.ok(ALLOWED_ENV.has(name), `${call.tool} received unexpected variable ${name}`)
  }
  assert.equal(helperCall(f, 'apply')?.stdin, KEY)
  assertNoKeyLeak(f, run)
})

test('--reuse-key sends an empty stdin when a managed key exists, ignoring any exported key', t => {
  const f = createFixture(t)
  f.setControl({ bun: { preflight: 'key-present' } })
  const run = f.inner(['--reuse-key'], { env: { CC_GATEWAY_UPSTREAM_API_KEY: SECOND_KEY } })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(f.steps(), [INSTALL, BUILD, 'preflight', 'apply'])
  assert.equal(helperCall(f, 'apply')?.stdin, '')
  assert.ok(!JSON.stringify(f.calls()).includes(SECOND_KEY))
})

test('--reuse-key without a managed key fails before apply', t => {
  const f = createFixture(t)
  f.setControl({ bun: { preflight: 'key-required' } })
  const run = f.inner(['--reuse-key'])
  assert.equal(run.status, 1)
  assert.match(run.stderr, /no valid managed API key to reuse/)
  assert.deepEqual(f.steps(), [INSTALL, BUILD, 'preflight'])
  assert.doesNotMatch(run.stdout, /ready/)
})

test('--api-key-stdin with empty input reuses a managed key', t => {
  const f = createFixture(t)
  f.setControl({ bun: { preflight: 'key-present' } })
  const run = f.inner(['--api-key-stdin'], { input: '' })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(helperCall(f, 'apply')?.stdin, '')
})

test('--api-key-stdin with empty input fails when no managed key exists', t => {
  const f = createFixture(t)
  f.setControl({ bun: { preflight: 'key-required' } })
  const run = f.inner(['--api-key-stdin'], { input: '' })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /needs a new API key/)
  assert.deepEqual(f.steps(), [INSTALL, BUILD, 'preflight'])
})

test('stdin keys containing a NUL byte are rejected before the helper sees them', t => {
  const f = createFixture(t)
  const run = f.inner(['--api-key-stdin'], { input: Buffer.concat([Buffer.from(`${KEY}`), Buffer.from([0]), Buffer.from('tail')]) })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /NUL byte or exceeds 16 KiB/)
  assert.equal(helperCall(f, 'apply'), undefined)
  assertNoKeyLeak(f, run)
})

test('stdin input is bounded at 16 KiB', t => {
  const f = createFixture(t)
  const tooLong = f.inner(['--api-key-stdin'], { input: 'a'.repeat(16385) })
  assert.equal(tooLong.status, 1)
  assert.match(tooLong.stderr, /exceeds 16 KiB/)
  assert.equal(helperCall(f, 'apply'), undefined)
  const limit = f.inner(['--api-key-stdin'], { input: 'a'.repeat(16384) })
  assert.equal(limit.status, 0, limit.stderr)
  assert.equal(helperCall(f, 'apply')?.stdin?.length, 16384)
})

test('without a key source or a terminal the installer stops after preflight and never prompts', t => {
  const f = createFixture(t)
  const run = f.inner([], { input: '' })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /No terminal is available\. Use --reuse-key, --api-key-stdin, or CC_GATEWAY_UPSTREAM_API_KEY/)
  assert.deepEqual(f.steps(), [INSTALL, BUILD, 'preflight'])
  assert.doesNotMatch(run.stdout + run.stderr, /Upstream API key:/)
})

test('dependency installation failure stops before the preflight and the key prompt', t => {
  const f = createFixture(t)
  f.setControl({ bun: { installStatus: 7 } })
  const run = f.inner(['--api-key-stdin'], { input: KEY })
  assert.equal(run.status, 7)
  assert.deepEqual(f.steps(), [INSTALL])
  assertNoKeyLeak(f, run)
})

test('build failure stops before the preflight and the key prompt', t => {
  const f = createFixture(t)
  f.setControl({ bun: { buildStatus: 9 } })
  const run = f.inner(['--api-key-stdin'], { input: KEY })
  assert.equal(run.status, 9)
  assert.deepEqual(f.steps(), [INSTALL, BUILD])
  assertNoKeyLeak(f, run)
})

test('helper failures keep their exit status and never print the success banner', t => {
  const f = createFixture(t)
  f.setControl({ bun: { status: { preflight: 9 } } })
  const preflight = f.inner(['--api-key-stdin'], { input: KEY })
  assert.equal(preflight.status, 9)
  assert.deepEqual(f.steps(), [INSTALL, BUILD, 'preflight'])

  const g = createFixture(t)
  g.setControl({ bun: { status: { apply: 4 } } })
  const apply = g.inner(['--api-key-stdin'], { input: KEY })
  assert.equal(apply.status, 4)
  assert.deepEqual(g.steps(), [INSTALL, BUILD, 'preflight', 'apply'])
  assert.doesNotMatch(apply.stdout, /ready/)
  assertNoKeyLeak(g, apply)
})

test('an unexpected preflight answer is refused', t => {
  const f = createFixture(t)
  f.setControl({ bun: { preflight: 'surprise' } })
  const run = f.inner(['--api-key-stdin'], { input: KEY })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /unexpected result/)
  assert.equal(helperCall(f, 'apply'), undefined)
})

// ----------------------------------------------------------- key management

test('--list-keys builds, lists, and neither prompts nor forwards any key', t => {
  const f = createFixture(t)
  const run = f.inner(['--list-keys'], { env: { CC_GATEWAY_UPSTREAM_API_KEY: KEY } })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(f.steps(), [INSTALL, BUILD, 'list-keys'])
  assert.match(run.stdout, /Keys: 2/)
  assert.doesNotMatch(run.stdout, /ready/)
  const list = helperCall(f, 'list-keys')
  assert.equal(list?.stdinKind, 'char')
  assert.equal(list?.helper?.index, undefined)
  assert.equal(list?.helper?.root, f.repo)
  assert.equal(list?.helper?.node, join(f.tools, 'node'))
  assertNoKeyLeak(f, run)
})

test('--list-keys passes the helper exit status through', t => {
  const f = createFixture(t)
  f.setControl({ bun: { status: { 'list-keys': 5 } } })
  const run = f.inner(['--list-keys'])
  assert.equal(run.status, 5)
})

test('--remove-key N sends the one-based index to the helper without a key prompt', t => {
  const f = createFixture(t)
  const run = f.inner(['--remove-key', '2'], { env: { CC_GATEWAY_UPSTREAM_API_KEY: KEY } })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(f.steps(), [INSTALL, BUILD, 'remove-key'])
  const remove = helperCall(f, 'remove-key')
  assert.equal(remove?.helper?.index, '2')
  assert.equal(remove?.stdinKind, 'char')
  assert.doesNotMatch(run.stdout, /ready/)
  assertNoKeyLeak(f, run)
})

test('--remove-key passes the helper exit status through', t => {
  const f = createFixture(t)
  f.setControl({ bun: { status: { 'remove-key': 6 } } })
  const run = f.inner(['--remove-key', '1'])
  assert.equal(run.status, 6)
})

for (const order of [['--add-key', '--api-key-stdin'], ['--api-key-stdin', '--add-key']]) {
  test(`${order.join(' ')} preflights, then sends one new key to add-key on stdin`, t => {
    const f = createFixture(t)
    f.setControl({ bun: { preflight: 'key-present' } })
    const run = f.inner(order, { input: `${SECOND_KEY}\n` })
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(f.steps(), [INSTALL, BUILD, 'preflight', 'add-key'])
    const add = helperCall(f, 'add-key')
    assert.equal(add?.stdin, `${SECOND_KEY}\n`)
    assert.equal(add?.stdinKind, 'pipe')
    assert.ok(!JSON.stringify(f.calls().filter(call => call.stdin === undefined)).includes(SECOND_KEY))
  })
}

test('--add-key never reuses a key: an empty stdin is refused', t => {
  const f = createFixture(t)
  f.setControl({ bun: { preflight: 'key-present' } })
  const run = f.inner(['--add-key', '--api-key-stdin'], { input: '' })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /needs a new API key/)
  assert.equal(helperCall(f, 'add-key'), undefined)
})

test('--add-key accepts an exported key when no terminal is available', t => {
  const f = createFixture(t)
  f.setControl({ bun: { preflight: 'key-present' } })
  const run = f.inner(['--add-key'], { env: { CC_GATEWAY_UPSTREAM_API_KEY: SECOND_KEY } })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(helperCall(f, 'add-key')?.stdin, SECOND_KEY)
  assert.ok(!JSON.stringify(f.calls().filter(call => call.stdin === undefined)).includes(SECOND_KEY))
})

// ------------------------------------------------- the root wrapper: sourced

function stateScript(f: InstallFixture, other: string, tail: string, epilogue = ''): string {
  return `
set -u
shopt -s extglob
trap "echo caller-trap" USR1
CALLER_VALUE="original value"
CALLER_ARRAY=(a "b c")
declare -A CALLER_MAP=([k]=v)
caller_function() { echo hello; }
export CALLER_EXPORTED=exported
snapshot() {
  local file=$1
  shift
  {
    pwd
    printf "<%s>" "$@"
    echo
    declare -F | sort
    trap -p
    shopt -p | sort
    set +o | sort
    compgen -v | sort
    declare -p CALLER_VALUE CALLER_ARRAY CALLER_MAP CALLER_EXPORTED
  } > "$file"
}
cd "${other}"
set -- keep "two words"
snapshot "${f.root}/before.txt" "$@"
${tail}
snapshot "${f.root}/after.txt" "$@"
declare -p > "${f.root}/vars.txt"
${epilogue}
`
}

test('sourcing succeeds, makes c available and leaves every other piece of shell state alone', t => {
  const f = createFixture(t)
  const other = join(f.root, 'elsewhere')
  mkdirSync(other)
  f.setControl({ bun: { createLauncher: true } })
  const run = f.caller(stateScript(f, other, [
    'command -v c > /dev/null && echo c-before-present || echo c-before-absent',
    `source "${f.repo}/install.sh" --api-key-stdin`,
    'echo "status=$?"',
  ].join('\n'), [
    'echo "path=$PATH"',
    'command -v c',
    'c',
  ].join('\n')), { cwd: f.repo, input: `${KEY}\n` })
  assert.equal(run.status, 0, run.stderr)
  const lines = run.stdout.split('\n')
  assert.ok(lines.includes('c-before-absent'))
  assert.ok(lines.includes('status=0'))
  assert.ok(lines.includes(`path=${f.bin}:${f.tools}`), 'only ~/.local/bin is prepended to PATH')
  assert.ok(lines.includes(join(f.bin, 'c')))
  assert.ok(lines.includes('launcher-ran'))

  const before = readFileSync(join(f.root, 'before.txt'), 'utf8')
  assert.ok(before.startsWith(`${other}\n<keep><two words>\n`))
  assert.equal(readFileSync(join(f.root, 'after.txt'), 'utf8'), before,
    'working directory, positional parameters, functions, traps, options and variables must be unchanged')
  assert.ok(!readFileSync(join(f.root, 'vars.txt'), 'utf8').includes(KEY), 'no caller variable may hold the key')
  assert.deepEqual(f.steps(), [INSTALL, BUILD, 'preflight', 'apply'])
  assertNoKeyLeak(f, run)
})

test('sourcing twice adds ~/.local/bin to PATH once', t => {
  const f = createFixture(t)
  f.setControl({ bun: { preflight: ['key-required', 'key-present'], createLauncher: true } })
  const run = f.caller([
    `source "${f.repo}/install.sh" --api-key-stdin`,
    'echo "first=$?"',
    `source "${f.repo}/install.sh" --reuse-key`,
    'echo "second=$?"',
    'echo "path=$PATH"',
  ].join('\n'), { input: `${KEY}\n` })
  assert.equal(run.status, 0, run.stderr)
  const lines = run.stdout.split('\n')
  assert.ok(lines.includes('first=0'))
  assert.ok(lines.includes('second=0'))
  const path = (lines.find(line => line.startsWith('path=')) ?? '').slice('path='.length).split(':')
  assert.equal(path.filter(entry => entry === f.bin).length, 1)
  assert.deepEqual(f.calls('bun').filter(call => call.helper?.action === 'apply').map(call => call.stdin), [`${KEY}\n`, ''])
})

test('a failed installation returns its status, keeps the caller alive and changes nothing in it', t => {
  const f = createFixture(t)
  const other = join(f.root, 'elsewhere')
  mkdirSync(other)
  f.setControl({ bun: { installStatus: 7 } })
  const run = f.caller(stateScript(f, other, [
    `source "${f.repo}/install.sh" --api-key-stdin`,
    'echo "status=$?"',
    'echo still-alive',
  ].join('\n'), 'echo "path=$PATH"'), { input: KEY })
  assert.equal(run.status, 0, run.stderr)
  const lines = run.stdout.split('\n')
  assert.ok(lines.includes('status=7'))
  assert.ok(lines.includes('still-alive'))
  assert.ok(lines.includes(`path=${f.tools}`), 'PATH must not change after a failure')
  assert.equal(readFileSync(join(f.root, 'after.txt'), 'utf8'), readFileSync(join(f.root, 'before.txt'), 'utf8'))
  assertNoKeyLeak(f, run)
})

test('--help through source prints the usage and leaves PATH alone', t => {
  const f = createFixture(t)
  const run = f.caller(`source ./install.sh --help\necho "status=$?"\necho "path=$PATH"`, { cwd: f.repo })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /Usage: source \.\/install\.sh/)
  const lines = run.stdout.split('\n')
  assert.ok(lines.includes('status=0'))
  assert.ok(lines.includes(`path=${f.tools}`))
  assert.deepEqual(f.calls(), [])
})

for (const [kind, definition] of [['alias', 'alias c="echo alias-c"'], ['function', 'c() { echo function-c; }']] as const) {
  test(`an existing ${kind} named c is refused before a child shell, tool or PATH change`, t => {
    const f = createFixture(t)
    const run = f.caller([
      'shopt -s expand_aliases',
      definition,
      `source "${f.repo}/install.sh" --api-key-stdin`,
      'echo "status=$?"',
      'echo "path=$PATH"',
      'builtin type -t c',
    ].join('\n'), { input: KEY })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stderr, /Your shell already defines c as an alias or function; it was left unchanged/)
    assert.match(run.stderr, /scripts\/install\.sh/)
    const lines = run.stdout.split('\n')
    assert.ok(lines.includes('status=1'))
    assert.ok(lines.includes(`path=${f.tools}`))
    assert.ok(lines.includes(kind), `the ${kind} must still be defined`)
    assert.doesNotMatch(run.stdout, /Installing locked dependencies/)
    assert.deepEqual(f.calls(), [])
    assertNoKeyLeak(f, run)
  })

  test(`--help still works while an ${kind} named c exists`, t => {
    const f = createFixture(t)
    const run = f.caller([
      'shopt -s expand_aliases',
      definition,
      `source "${f.repo}/install.sh" --help`,
      'echo "status=$?"',
      'builtin type -t c',
    ].join('\n'))
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /Usage: source \.\/install\.sh/)
    assert.ok(run.stdout.split('\n').includes('status=0'))
    assert.ok(run.stdout.split('\n').includes(kind))
    assert.deepEqual(f.calls(), [])
  })
}

test('an existing c executable is not mistaken for a shell definition', t => {
  const f = createFixture(t)
  mkdirSync(f.bin, { recursive: true })
  writeFileSync(join(f.bin, 'c'), '#!/bin/sh\necho existing-launcher\n', { mode: 0o755 })
  const run = f.caller([
    `source "${f.repo}/install.sh" --api-key-stdin`,
    'echo "status=$?"',
  ].join('\n'), { input: KEY, env: { PATH: `${f.bin}:${f.tools}` } })
  assert.equal(run.status, 0, run.stderr)
  assert.ok(run.stdout.split('\n').includes('status=0'))
  assert.deepEqual(f.steps(), [INSTALL, BUILD, 'preflight', 'apply'])
})

test('the caller BASH_ENV file is not run by the installer shell', t => {
  const f = createFixture(t)
  const marker = join(f.root, 'bash-env-marker')
  const bashEnv = join(f.root, 'bash-env.sh')
  writeFileSync(bashEnv, `echo "$$" >> "${marker}"\n`)
  const run = f.caller([
    'echo "caller=$$"',
    `source "${f.repo}/install.sh" --api-key-stdin`,
    'echo "status=$?"',
  ].join('\n'), { input: KEY, env: { BASH_ENV: bashEnv } })
  assert.equal(run.status, 0, run.stderr)
  const callerPid = (run.stdout.split('\n').find(line => line.startsWith('caller=')) ?? '').slice('caller='.length)
  assert.ok(callerPid.length > 0)
  assert.deepEqual(readFileSync(marker, 'utf8').trim().split('\n'), [callerPid],
    'only the caller itself may have read BASH_ENV')
  assert.ok(run.stdout.split('\n').includes('status=0'))
})

// Bash imports exported functions from the environment, so a caller that exports
// something named uname, systemctl or sha256sum could redirect the installer child.
// The wrapper starts the child with -p, which disables that import.
test('exported caller functions do not reach the installer child', t => {
  const f = createFixture(t)
  f.setControl({ bun: { preflight: 'key-present' } })
  const run = f.caller([
    'uname() { echo Darwin; }',
    'export -f uname',
    `source "${f.repo}/install.sh" --reuse-key`,
    'echo "status=$?"',
  ].join('\n'))
  assert.ok(run.stdout.split('\n').includes('status=0'), run.stderr)
})

// ----------------------------------------------- the root wrapper: executed

test('executing ./install.sh prints how to enable c when ~/.local/bin is not on PATH', t => {
  const f = createFixture(t)
  const run = f.wrapper(['--api-key-stdin'], { input: KEY })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /To enable c in this shell, run: source \.\/install\.sh --reuse-key/)
  assert.deepEqual(f.steps(), [INSTALL, BUILD, 'preflight', 'apply'])
  assertNoKeyLeak(f, run)
})

test('executing ./install.sh stays quiet about PATH when ~/.local/bin is already on it', t => {
  const f = createFixture(t)
  const run = f.wrapper(['--api-key-stdin'], { input: KEY, env: { PATH: `${f.bin}:${f.tools}` } })
  assert.equal(run.status, 0, run.stderr)
  assert.doesNotMatch(run.stdout, /To enable c in this shell/)
})

test('executing ./install.sh propagates the installer exit status without the PATH hint', t => {
  const f = createFixture(t)
  f.setControl({ bun: { installStatus: 7 } })
  const run = f.wrapper(['--api-key-stdin'], { input: KEY })
  assert.equal(run.status, 7)
  assert.doesNotMatch(run.stdout, /To enable c in this shell/)
})

test('executing ./install.sh --help prints only the usage', t => {
  const f = createFixture(t)
  const run = f.wrapper(['--help'])
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /Usage: source \.\/install\.sh/)
  assert.doesNotMatch(run.stdout, /To enable c/)
  assert.deepEqual(f.calls(), [])
})

const SH = existsSync('/bin/sh') ? realpathSync('/bin/sh') : undefined
test('a non-Bash shell is told to use Bash', { skip: SH === undefined || /(^|\/)bash$/.test(SH) }, t => {
  const f = createFixture(t)
  const run = f.plain('/bin/sh', [join(f.repo, 'install.sh')])
  assert.equal(run.status, 2)
  assert.match(run.stderr, /Use Bash: source \.\/install\.sh/)
  assert.deepEqual(f.calls(), [])
})

// -------------------------------------------------------- runtime bootstrap

test('the runtime version policy accepts Bun 1.4+ and Node 24+ release versions only', t => {
  const f = createFixture(t)
  const cases: Array<[string, string, boolean]> = [
    ['bun', '1.4.0', true], ['bun', 'v1.4.0', true], ['bun', '1.4.9', true], ['bun', '1.10.0', true],
    ['bun', '2.0.0', true], ['bun', '01.04.00', true], ['bun', '1.08.0', true],
    ['bun', '1.3.9', false], ['bun', '0.9.9', false], ['bun', '1.4', false], ['bun', '', false],
    ['bun', 'x', false], ['bun', '1.4.0-canary.1', false], ['bun', '1.4.0-canary.1 (bcba4722b)', false],
    ['node', 'v24.21.0', true], ['node', '24.0.0', true], ['node', 'v25.0.0', true],
    ['node', 'v23.11.0', false], ['node', '24', false], ['node', 'v24.21', false],
    ['deno', '1.4.0', false],
  ]
  const run = f.lib([
    'check() { if cc_gateway_runtime_version_ok "$1" "$2"; then echo "$1 $2 ok"; else echo "$1 $2 no"; fi; }',
    ...cases.map(([kind, version]) => `check ${kind} ${JSON.stringify(version)}`),
  ].join('\n'))
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(run.stdout.trimEnd().split('\n'), cases.map(([kind, version, ok]) => `${kind} ${version} ${ok ? 'ok' : 'no'}`))
})

test('required tools are checked by name', t => {
  const f = createFixture(t)
  const run = f.lib('cc_gateway_require_tools bash definitely-missing-tool\necho "status=$?"')
  assert.match(run.stderr, /Required tool is missing: definitely-missing-tool/)
  assert.match(run.stdout, /status=1/)
})

test('a compatible PATH runtime is selected as is', t => {
  const f = createFixture(t)
  const run = f.lib(`cc_gateway_select_runtime bun x64 "${f.runtimeBase}"\necho "status=$?"`)
  assert.deepEqual(run.stdout.trimEnd().split('\n'), [join(f.tools, 'bun'), 'status=0'])
  assert.deepEqual(f.calls('curl'), [])
})

test('an out-of-date PATH runtime is not used and, without curl, nothing is downloaded', t => {
  const f = createFixture(t)
  f.setControl({ bun: { version: '1.3.9' } })
  const run = f.lib('cc_gateway_bootstrap_runtime\necho "status=$?"')
  assert.match(run.stderr, /Required tool is missing: curl/)
  assert.match(run.stdout, /status=1/)
  assert.deepEqual(f.calls('curl'), [])
})

test('only the missing runtime needs its extraction tools', t => {
  const f = createFixture(t)
  f.removeTool('node')
  f.addTool('curl')
  const run = f.lib('cc_gateway_bootstrap_runtime\necho "status=$?"')
  assert.match(run.stderr, /Required tool is missing: tar/)
  assert.doesNotMatch(run.stderr, /unzip/, 'Bun came from PATH, so unzip is not needed')
  assert.match(run.stdout, /status=1/)
  assert.deepEqual(f.calls('curl'), [], 'nothing is downloaded when an extraction tool is missing')
})

test('a symlinked runtime directory is refused', t => {
  const f = createFixture(t)
  const real = join(f.root, 'real-runtime')
  mkdirSync(real, { mode: 0o700 })
  mkdirSync(join(f.data, 'cc-gateway'), { recursive: true })
  symlinkSync(real, f.runtimeBase)
  const run = f.lib('cc_gateway_bootstrap_runtime\necho "status=$?"')
  assert.match(run.stderr, /The runtime directory must not be a symlink/)
  assert.match(run.stdout, /status=1/)
})

for (const [machine, arch] of [['x86_64', 'x64'], ['amd64', 'x64'], ['aarch64', 'arm64'], ['arm64', 'arm64']] as const) {
  test(`downloads verified Bun and Node for ${machine}, keeps receipts, and reuses them afterwards`, t => {
    const f = createFixture(t)
    provisioning(f)
    f.setControl({ uname: { m: machine } })
    const bun = RUNTIMES[`bun:${arch}` as RuntimeKey]
    const node = RUNTIMES[`node:${arch}` as RuntimeKey]
    const bunTarget = join(f.runtimeBase, `bun-${bun.version}-linux-${arch}`)
    const nodeTarget = join(f.runtimeBase, `node-${node.version}-linux-${arch}`)
    const script = 'cc_gateway_bootstrap_runtime\necho "status=$?"\necho "bun=$CC_GATEWAY_BUN"\necho "node=$CC_GATEWAY_NODE"'
    const expected = ['status=0', `bun=${join(bunTarget, 'bin', 'bun')}`, `node=${join(nodeTarget, 'bin', 'node')}`]

    const first = f.lib(script)
    assert.equal(first.status, 0, first.stderr)
    assert.deepEqual(first.stdout.trimEnd().split('\n'), expected)
    assert.deepEqual(f.calls('curl').map(call => call.url), [bun.url, node.url])
    for (const call of f.calls('curl')) {
      assert.equal(call.argv[0], '--disable')
      assert.ok(call.argv.join(' ').includes('--proto =https --proto-redir =https'), 'only HTTPS, including redirects')
      assert.ok(call.argv.includes('--fail'))
      assert.ok(call.argv.includes('--max-time'))
    }
    assert.deepEqual(f.calls('unzip').map(call => call.member), [bun.member])
    assert.deepEqual(f.calls('tar').map(call => call.member), [node.member])
    assert.deepEqual(readdirSync(f.runtimeBase).sort(), [`bun-${bun.version}-linux-${arch}`, `node-${node.version}-linux-${arch}`].sort(),
      'download, extraction and staging directories must be cleaned up')
    for (const [kind, pin, target] of [['bun', bun, bunTarget], ['node', node, nodeTarget]] as const) {
      const binary = join(target, 'bin', kind)
      assert.equal(readFileSync(join(target, '.owner'), 'utf8'), 'cc-gateway-runtime-v1\n')
      assert.equal(readFileSync(join(target, 'archive.sha256'), 'utf8'), `${pin.sha}\n`)
      assert.equal(readFileSync(join(target, 'binary.sha256'), 'utf8'), `${createHash('sha256').update(readFileSync(binary)).digest('hex')}\n`)
      assert.equal(statSync(binary).mode & 0o777, 0o700)
      assert.equal(statSync(target).mode & 0o022, 0, 'the runtime must not be group or world writable')
    }

    const second = f.lib(script)
    assert.deepEqual(second.stdout.trimEnd().split('\n'), expected)
    assert.equal(f.calls('curl').length, 2, 'verified runtimes are reused without another download')
  })
}

test('a tampered archive is refused before it is extracted or executed', t => {
  const f = createFixture(t)
  provisioning(f)
  f.setControl({ curl: { tamper: true } })
  const run = f.lib('cc_gateway_bootstrap_runtime\necho "status=$?"')
  assert.match(run.stderr, /Runtime archive SHA-256 verification failed/)
  assert.match(run.stdout, /status=1/)
  assert.deepEqual(f.calls('unzip'), [])
  assert.deepEqual(f.calls('tar'), [])
  assert.deepEqual(readdirSync(f.runtimeBase), [], 'nothing may be installed or left behind')
})

test('a download failure leaves no partial runtime behind', t => {
  const f = createFixture(t)
  provisioning(f)
  f.setControl({ curl: { status: 22 } })
  const run = f.lib('cc_gateway_bootstrap_runtime\necho "status=$?"')
  assert.match(run.stdout, /status=1/)
  assert.deepEqual(readdirSync(f.runtimeBase), [])
  assert.deepEqual(f.calls('unzip'), [])
})

test('a downloaded runtime that reports the wrong version is not installed', t => {
  const f = createFixture(t)
  provisioning(f)
  f.setControl({ extracted: { bun: '1.4.1' } })
  const run = f.lib('cc_gateway_bootstrap_runtime\necho "status=$?"')
  assert.match(run.stderr, /Downloaded runtime version does not match its pin/)
  assert.match(run.stdout, /status=1/)
  assert.deepEqual(readdirSync(f.runtimeBase), [])
})

// ------------------------------------------------------ managed receipts

test('a verified managed runtime is returned without any download', t => {
  const f = createFixture(t)
  const bun = f.managedRuntime('bun', 'x64')
  const node = f.managedRuntime('node', 'arm64')
  const run = f.lib([
    `cc_gateway_managed_runtime bun x64 "${f.runtimeBase}"`,
    `cc_gateway_managed_runtime node arm64 "${f.runtimeBase}"`,
    'echo "status=$?"',
  ].join('\n'))
  assert.deepEqual(run.stdout.trimEnd().split('\n'), [bun.binary, node.binary, 'status=0'])
  assert.deepEqual(f.calls('curl'), [])
})

const damaged: Array<{
  name: string
  options?: { reportedVersion?: string }
  mutate?: (layout: { target: string; binary: string }) => void
  pattern: RegExp
}> = [
  { name: 'a binary that no longer matches its receipt', mutate: ({ binary }) => writeFileSync(binary, `${fakeBinaryText('1.4.0')}// tampered\n`), pattern: /Managed runtime verification failed/ },
  { name: 'an archive receipt from another release', mutate: ({ target }) => writeFileSync(join(target, 'archive.sha256'), `${'0'.repeat(64)}\n`), pattern: /Managed runtime verification failed/ },
  { name: 'a foreign owner marker', mutate: ({ target }) => writeFileSync(join(target, '.owner'), 'someone-else\n'), pattern: /Managed runtime verification failed/ },
  { name: 'a malformed binary receipt', mutate: ({ target }) => writeFileSync(join(target, 'binary.sha256'), 'not-a-digest\n'), pattern: /Managed runtime verification failed/ },
  { name: 'an empty binary receipt', mutate: ({ target }) => writeFileSync(join(target, 'binary.sha256'), ''), pattern: /receipts are incomplete/ },
  { name: 'a missing receipt', mutate: ({ target }) => rmSync(join(target, 'archive.sha256')), pattern: /left unchanged/ },
  { name: 'a group-writable receipt', mutate: ({ target }) => chmodSync(join(target, '.owner'), 0o664), pattern: /unsafe ownership or permissions/ },
  { name: 'a group-writable runtime directory', mutate: ({ target }) => chmodSync(target, 0o770), pattern: /unsafe ownership or permissions/ },
  { name: 'a non-executable binary', mutate: ({ binary }) => chmodSync(binary, 0o600), pattern: /left unchanged/ },
  {
    name: 'a symlinked runtime directory',
    mutate: ({ target }) => {
      const moved = `${target}.moved`
      renameSync(target, moved)
      symlinkSync(moved, target)
    },
    pattern: /unsafe ownership or permissions/,
  },
  { name: 'a binary that reports a different version', options: { reportedVersion: '1.4.1' }, pattern: /version does not match its pin/ },
]
for (const scenario of damaged) {
  test(`refuses ${scenario.name} and leaves it in place`, t => {
    const f = createFixture(t)
    f.addTool('curl')
    const layout = f.managedRuntime('bun', 'x64', scenario.options)
    scenario.mutate?.(layout)
    const run = f.lib(`cc_gateway_managed_runtime bun x64 "${f.runtimeBase}"\necho "status=$?"`)
    assert.match(run.stderr, scenario.pattern)
    assert.equal(run.stdout.trimEnd(), 'status=1', 'no path may be printed for an unverified runtime')
    assert.deepEqual(f.calls('curl'), [], 'an unverifiable runtime is never silently replaced')
    assert.ok(existsSync(layout.target))
  })
}

test('a world-writable runtime base directory is refused', t => {
  const f = createFixture(t)
  f.managedRuntime('bun', 'x64')
  chmodSync(f.runtimeBase, 0o777)
  const run = f.lib(`cc_gateway_managed_runtime bun x64 "${f.runtimeBase}"\necho "status=$?"`)
  assert.match(run.stderr, /The runtime directory must be owned by you, writable only by you, and not a symlink/)
  assert.equal(run.stdout.trimEnd(), 'status=1')
})

test('a PATH entry inside the managed directory is only trusted after receipt verification', t => {
  const f = createFixture(t)
  f.removeTool('bun')
  const layout = f.managedRuntime('bun', 'x64')
  symlinkSync(layout.binary, join(f.tools, 'bun'))
  const script = `cc_gateway_select_runtime bun x64 "${f.runtimeBase}"\necho "status=$?"`

  const valid = f.lib(script)
  assert.deepEqual(valid.stdout.trimEnd().split('\n'), [layout.binary, 'status=0'])

  writeFileSync(layout.binary, `${fakeBinaryText('1.4.0')}// tampered\n`)
  const tampered = f.lib(script)
  assert.match(tampered.stderr, /Managed runtime verification failed/)
  assert.equal(tampered.stdout.trimEnd(), 'status=1')
})

// A second key must never appear in anything but the helper's stdin.
test('keys supplied for different actions stay out of every argument and environment', (t: TestContext) => {
  const f = createFixture(t)
  f.setControl({ bun: { preflight: 'key-present' } })
  const runs = [
    f.inner(['--api-key-stdin'], { input: `${KEY}\n` }),
    f.inner(['--add-key', '--api-key-stdin'], { input: `${KEY}\n` }),
    f.inner(['--list-keys'], { env: { CC_GATEWAY_UPSTREAM_API_KEY: KEY } }),
    f.inner(['--remove-key', '1'], { env: { CC_GATEWAY_UPSTREAM_API_KEY: KEY } }),
  ]
  for (const run of runs) assert.equal(run.status, 0, run.stderr)
  assertNoKeyLeak(f, ...runs)
  const withStdin = f.calls('bun').filter(call => call.stdin !== undefined)
  assert.deepEqual(withStdin.map(call => call.helper?.action), ['apply', 'add-key'])
})
