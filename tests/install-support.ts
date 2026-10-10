import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync, chmodSync, constants, copyFileSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TestContext } from 'node:test'

// Dummy credentials only. The stubs flag any environment value or argument containing KEY_MARKER.
export const KEY = 'sk-test-DUMMY-0123456789abcdef'
export const SECOND_KEY = 'sk-test-DUMMY-fedcba9876543210'
const KEY_MARKER = 'sk-test-DUMMY'

export type RuntimeKey = 'bun:x64' | 'bun:arm64' | 'node:x64' | 'node:arm64'
export interface Runtime {
  archive: string
  sha: string
  url: string
  version: string
  member: string
}

// Official release digests, independent of the installer's own constants.
export const RUNTIMES: Record<RuntimeKey, Runtime> = {
  'bun:x64': {
    archive: 'bun-linux-x64-baseline.zip',
    sha: '184fb4595f0d401a217cf7c78c1bc430ba83314dab7a8b94805babbf7fa7097f',
    url: 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-linux-x64-baseline.zip',
    version: '1.4.0',
    member: 'bun-linux-x64-baseline/bun',
  },
  'bun:arm64': {
    archive: 'bun-linux-aarch64.zip',
    sha: '4b1a332ee861983eb93bcfe6f770fff94e3e31b2c388bdaea3c8ed35e58eed0e',
    url: 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-linux-aarch64.zip',
    version: '1.4.0',
    member: 'bun-linux-aarch64/bun',
  },
  'node:x64': {
    archive: 'node-v24.21.0-linux-x64.tar.xz',
    sha: 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
    url: 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz',
    version: '24.21.0',
    member: 'node-v24.21.0-linux-x64/bin/node',
  },
  'node:arm64': {
    archive: 'node-v24.21.0-linux-arm64.tar.xz',
    sha: '6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2',
    url: 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-arm64.tar.xz',
    version: '24.21.0',
    member: 'node-v24.21.0-linux-arm64/bin/node',
  },
}

export interface Control {
  uname?: { s?: string; m?: string }
  systemctlFail?: boolean
  node?: { version?: string }
  bun?: {
    version?: string
    installStatus?: number
    buildStatus?: number
    preflight?: string | string[]
    listOutput?: string
    status?: Record<string, number>
    createLauncher?: boolean
  }
  curl?: { status?: number; tamper?: boolean }
  unzipStatus?: number
  extracted?: { bun?: string; node?: string }
}

export interface Call {
  tool: string
  argv: string[]
  cwd: string
  path: string
  envNames: string[]
  keyInEnv: boolean
  keyInArgv: boolean
  stdinKind: string
  noEnvFile?: boolean
  args?: string[]
  helper?: { action: string; root?: string; node?: string; index?: string }
  stdin?: string
  url?: string
  member?: string
}

export interface RunOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  input?: string | Buffer
}

export interface Run {
  status: number | null
  stdout: string
  stderr: string
}

export type StubName = 'uname' | 'systemctl' | 'claude' | 'bun' | 'node' | 'sha256sum' | 'curl' | 'unzip' | 'tar' | 'xz'

// Real commands the scripts need. Everything else on PATH is a stub, so the host's
// Bun, Node, curl and Claude can never be picked up by accident.
const REAL_TOOLS = ['bash', 'dirname', 'realpath', 'stat', 'mkdir', 'mktemp', 'chmod', 'cp', 'mv', 'rm', 'sort'] as const
const DEFAULT_STUBS: readonly StubName[] = ['uname', 'systemctl', 'claude', 'bun', 'node', 'sha256sum']

export function fakeBinaryText(version: string): string {
  return '#!' + process.execPath + '\nif (process.argv[2] === "--version") console.log(' + JSON.stringify(version) + ');\n'
}

// CommonJS, no backticks and no dollar-brace sequences: it is written to disk verbatim.
const STUB_LIBRARY = String.raw`'use strict';
var fs = require('node:fs');
var path = require('node:path');
var crypto = require('node:crypto');
var FIX = __FIXTURE__;
var PINS = __PINS__;
var MARKER = 'sk-test-DUMMY';

function control() {
  try { return JSON.parse(fs.readFileSync(path.join(FIX, 'control.json'), 'utf8')); } catch (error) { return {}; }
}
function out(text) { fs.writeSync(1, text + '\n'); }
function err(text) { fs.writeSync(2, text + '\n'); }
function stdinKind() {
  try {
    var st = fs.fstatSync(0);
    if (st.isFIFO()) return 'pipe';
    if (st.isCharacterDevice()) return 'char';
    if (st.isSocket()) return 'socket';
    if (st.isFile()) return 'file';
    return 'other';
  } catch (error) { return 'closed'; }
}
function finish(record, status) {
  fs.appendFileSync(path.join(FIX, 'calls.jsonl'), JSON.stringify(record) + '\n');
  process.exit(status);
}
function fakeBinary(file, version) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!' + process.execPath + '\nif (process.argv[2] === "--version") console.log(' + JSON.stringify(version) + ');\n', { mode: 0o755 });
}
function nextPreflight(b) {
  var sequence = Array.isArray(b.preflight) ? b.preflight : [b.preflight || 'key-required'];
  var file = path.join(FIX, 'preflight.count');
  var n = 0;
  try { n = parseInt(fs.readFileSync(file, 'utf8'), 10) || 0; } catch (error) { n = 0; }
  fs.writeFileSync(file, String(n + 1));
  return sequence[Math.min(n, sequence.length - 1)];
}

var HANDLERS = {
  uname: function (r, argv, c) {
    var u = c.uname || {};
    out(argv[0] === '-m' ? (u.m || 'x86_64') : (u.s || 'Linux'));
    finish(r, 0);
  },
  systemctl: function (r, argv, c) {
    if (c.systemctlFail && argv.indexOf('show-environment') !== -1) {
      err('Failed to connect to bus: No medium found');
      finish(r, 1);
    }
    finish(r, 0);
  },
  claude: function (r) { finish(r, 0); },
  node: function (r, argv, c) {
    if (argv[0] === '--version') out((c.node && c.node.version) || 'v24.21.0');
    finish(r, 0);
  },
  bun: function (r, argv, c) {
    var b = c.bun || {};
    var args = argv.slice();
    r.noEnvFile = args[0] === '--no-env-file';
    if (r.noEnvFile) args.shift();
    r.args = args;
    var status = b.status || {};
    if (args[0] === '--version') { out(b.version || '1.4.0'); finish(r, 0); }
    if (args[0] === 'install') { out('bun install stub'); finish(r, b.installStatus || 0); }
    if (args[0] === 'run' && args[1] === 'build') { out('bun build stub'); finish(r, b.buildStatus || 0); }
    if (/install\.ts$/.test(args[0] || '')) {
      var action = args[1];
      var options = {};
      for (var i = 2; i + 1 < args.length; i += 2) options[args[i]] = args[i + 1];
      r.helper = { action: action, root: options['--root'], node: options['--node'], index: options['--index'] };
      var code = status[action] || 0;
      if (action === 'preflight') { out(nextPreflight(b)); finish(r, code); }
      if (action === 'list-keys') { out(b.listOutput || 'Keys: 2\n1 primary\n2 fallback'); finish(r, code); }
      if (action === 'apply' || action === 'add-key') {
        r.stdin = fs.readFileSync(0, 'utf8');
        if (code === 0 && action === 'apply' && b.createLauncher) {
          var bin = path.join(process.env.HOME, '.local', 'bin');
          fs.mkdirSync(bin, { recursive: true });
          fs.writeFileSync(path.join(bin, 'c'), '#!/bin/sh\necho launcher-ran\n', { mode: 0o755 });
        }
      }
      finish(r, code);
    }
    err('unexpected bun invocation');
    finish(r, 99);
  },
  curl: function (r, argv, c) {
    var o = c.curl || {};
    var url = argv[argv.length - 1];
    r.url = url;
    if (o.status) { err('curl: (22) stub failure'); finish(r, o.status); }
    var target = argv[argv.indexOf('--output') + 1];
    fs.writeFileSync(target, (o.tamper ? 'TAMPERED:' : 'ARCHIVE:') + path.basename(url) + '\n');
    finish(r, 0);
  },
  sha256sum: function (r) {
    var data = fs.readFileSync(0);
    var text = data.toString('latin1');
    var digest = text.indexOf('ARCHIVE:') === 0 ? PINS[text.slice(8).trim()] : undefined;
    if (!digest) digest = crypto.createHash('sha256').update(data).digest('hex');
    out(digest + '  -');
    finish(r, 0);
  },
  unzip: function (r, argv, c) {
    var at = argv.indexOf('-d');
    var member = argv[at - 1];
    r.member = member;
    if (c.unzipStatus) { err('unzip: stub failure'); finish(r, c.unzipStatus); }
    fakeBinary(path.join(argv[at + 1], member), (c.extracted && c.extracted.bun) || '1.4.0');
    finish(r, 0);
  },
  tar: function (r, argv, c) {
    var dir = argv[argv.indexOf('--directory') + 1];
    var member = argv[argv.indexOf('--') + 1];
    r.member = member;
    fakeBinary(path.join(dir, member), (c.extracted && c.extracted.node) || 'v24.21.0');
    finish(r, 0);
  },
  xz: function (r) { finish(r, 0); }
};

exports.run = function (tool) {
  var argv = process.argv.slice(2);
  var env = process.env;
  var record = {
    tool: tool,
    argv: argv,
    cwd: process.cwd(),
    path: env.PATH || '',
    envNames: Object.keys(env).sort(),
    keyInEnv: Object.keys(env).some(function (name) { return String(env[name]).indexOf(MARKER) !== -1; }),
    keyInArgv: argv.some(function (arg) { return arg.indexOf(MARKER) !== -1; }),
    stdinKind: stdinKind()
  };
  HANDLERS[tool](record, argv, control());
};
`

function findExecutable(name: string): string {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, name)
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`The test host needs ${name} on PATH`)
}

export class InstallFixture {
  readonly root: string
  readonly repo: string
  readonly home: string
  readonly data: string
  readonly config: string
  readonly tools: string
  readonly bin: string
  readonly runtimeBase: string
  readonly bash: string
  private state: Control = {}

  constructor() {
    this.root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-gateway-install-')))
    this.repo = join(this.root, 'repo')
    this.home = join(this.root, 'home')
    this.data = join(this.root, 'data')
    this.config = join(this.root, 'config')
    this.tools = join(this.root, 'tools')
    this.bin = join(this.home, '.local', 'bin')
    this.runtimeBase = join(this.data, 'cc-gateway', 'runtime')
    this.bash = findExecutable('bash')

    for (const directory of [this.repo, this.home, this.config, this.tools]) mkdirSync(directory, { recursive: true })
    const source = join(dirname(fileURLToPath(import.meta.url)), '..')
    for (const file of ['install.sh', 'scripts/install.sh', 'scripts/bootstrap-runtime.sh']) {
      mkdirSync(dirname(join(this.repo, file)), { recursive: true })
      copyFileSync(join(source, file), join(this.repo, file))
      chmodSync(join(this.repo, file), 0o755)
    }
    mkdirSync(join(this.repo, 'src', 'scripts'), { recursive: true })
    writeFileSync(join(this.repo, 'src', 'scripts', 'install.ts'), '// helper entry point stub\n')
    writeFileSync(join(this.repo, 'package.json'), '{}\n')
    writeFileSync(join(this.repo, 'bun.lock'), '')

    const pins: Record<string, string> = {}
    for (const runtime of Object.values(RUNTIMES)) pins[runtime.archive] = runtime.sha
    writeFileSync(join(this.root, 'stub-lib.cjs'), STUB_LIBRARY
      .replace('__FIXTURE__', () => JSON.stringify(this.root))
      .replace('__PINS__', () => JSON.stringify(pins)))
    writeFileSync(join(this.tools, 'package.json'), '{"type":"commonjs"}\n')
    for (const tool of REAL_TOOLS) symlinkSync(findExecutable(tool), join(this.tools, tool))
    for (const stub of DEFAULT_STUBS) this.addTool(stub)
    this.setControl({})
  }

  addTool(name: StubName): void {
    const file = join(this.tools, name)
    rmSync(file, { force: true })
    writeFileSync(file, '#!' + process.execPath + '\nrequire(' + JSON.stringify(join(this.root, 'stub-lib.cjs')) + ').run(' + JSON.stringify(name) + ')\n', { mode: 0o755 })
  }

  removeTool(name: StubName): void {
    rmSync(join(this.tools, name), { force: true })
  }

  setControl(patch: Control): void {
    this.state = { ...this.state, ...patch }
    writeFileSync(join(this.root, 'control.json'), JSON.stringify(this.state))
  }

  env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: this.tools,
      HOME: this.home,
      XDG_DATA_HOME: this.data,
      XDG_CONFIG_HOME: this.config,
      LANG: 'C.UTF-8',
      TERM: 'dumb',
    }
    for (const [name, value] of Object.entries(extra)) {
      if (value === undefined) delete env[name]
      else env[name] = value
    }
    return env
  }

  calls(tool?: string): Call[] {
    let text = ''
    try {
      text = readFileSync(join(this.root, 'calls.jsonl'), 'utf8')
    } catch {
      return []
    }
    const calls = text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Call)
    return tool === undefined ? calls : calls.filter(call => call.tool === tool)
  }

  /** Install, build and helper actions in order, without the runtime selection probes. */
  steps(): string[] {
    return this.calls('bun')
      .filter(call => call.argv[0] !== '--version')
      .map(call => call.helper ? call.helper.action : (call.args ?? []).join(' '))
  }

  /** A managed runtime laid out exactly as the installer would have left it. */
  managedRuntime(kind: 'bun' | 'node', arch: 'x64' | 'arm64', options: { reportedVersion?: string } = {}): { target: string; binary: string } {
    const pin = RUNTIMES[`${kind}:${arch}` as RuntimeKey]
    const target = join(this.runtimeBase, `${kind}-${pin.version}-linux-${arch}`)
    const binary = join(target, 'bin', kind)
    mkdirSync(join(target, 'bin'), { recursive: true, mode: 0o700 })
    for (const directory of [this.runtimeBase, target, join(target, 'bin')]) chmodSync(directory, 0o700)
    const reported = options.reportedVersion ?? (kind === 'node' ? `v${pin.version}` : pin.version)
    writeFileSync(binary, fakeBinaryText(reported), { mode: 0o700 })
    chmodSync(binary, 0o700)
    const digest = createHash('sha256').update(readFileSync(binary)).digest('hex')
    writeFileSync(join(target, '.owner'), 'cc-gateway-runtime-v1\n', { mode: 0o600 })
    writeFileSync(join(target, 'archive.sha256'), `${pin.sha}\n`, { mode: 0o600 })
    writeFileSync(join(target, 'binary.sha256'), `${digest}\n`, { mode: 0o600 })
    return { target, binary }
  }

  private execute(file: string, args: string[], options: RunOptions): Run {
    const result = spawnSync(file, args, {
      cwd: options.cwd ?? this.repo,
      env: this.env(options.env),
      input: options.input ?? '',
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    if (result.error) throw result.error
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  /** The installer body, run the way the root wrapper runs it. */
  inner(args: string[], options: RunOptions = {}): Run {
    return this.execute(this.bash, ['--noprofile', '--norc', join(this.repo, 'scripts', 'install.sh'), ...args], options)
  }

  /** ./install.sh executed rather than sourced. */
  wrapper(args: string[], options: RunOptions = {}): Run {
    return this.execute(join(this.repo, 'install.sh'), args, options)
  }

  /** A non-interactive caller shell; $0 is "caller", so sourcing is detected as in a real terminal. */
  caller(script: string, options: RunOptions = {}): Run {
    return this.execute(this.bash, ['--noprofile', '--norc', '-c', script, 'caller'], options)
  }

  /** Source the bootstrap library, then run the given bash. */
  lib(script: string, options: RunOptions = {}): Run {
    const library = join(this.repo, 'scripts', 'bootstrap-runtime.sh')
    return this.execute(this.bash, ['--noprofile', '--norc', '-c', `source "${library}"\n${script}`, 'lib'], options)
  }

  /** Any other interpreter, for the not-Bash path. */
  plain(file: string, args: string[], options: RunOptions = {}): Run {
    return this.execute(file, args, options)
  }
}

export function createFixture(t: TestContext): InstallFixture {
  const fixture = new InstallFixture()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  return fixture
}

/** The key must reach the helper only through stdin: never output, argv or any environment. */
export function assertNoKeyLeak(f: InstallFixture, ...runs: Run[]): void {
  for (const run of runs) {
    assert.ok(!run.stdout.includes(KEY), 'stdout must not contain the key')
    assert.ok(!run.stderr.includes(KEY), 'stderr must not contain the key')
  }
  for (const call of f.calls()) {
    assert.equal(call.keyInEnv, false, `${call.tool} must not see the key in its environment`)
    assert.equal(call.keyInArgv, false, `${call.tool} must not see the key in its arguments`)
  }
}
