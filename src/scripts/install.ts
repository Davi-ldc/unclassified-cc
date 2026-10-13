import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, statSync,
  symlinkSync, unlinkSync, writeFileSync, type Stats,
} from 'node:fs'
import { request } from 'node:http'
import { createServer, isIP } from 'node:net'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseDocument } from 'yaml'
import { parseConfig, type Config } from '../config.js'
import { createSetupFiles, renderLauncher } from './setup.js'

const UNIT = 'cc-gateway.service'
const MARKER = '# Managed by cc-gateway installer.'
const DUMMY_KEY = 'installer-schema-validation-only'
const MAX_FILE = 1024 * 1024
const TIMEOUT = 5000
// A restart must outlast the unit's 10-second stop timeout.
const SYSTEMCTL_TIMEOUT = 20_000

export class InstallError extends Error {}
function fail(message: string): never { throw new InstallError(message) }
function safeError(error: unknown): InstallError {
  return error instanceof InstallError ? error : new InstallError('Installation failed; no diagnostic contents were printed.')
}

export type CommandResult = { code: number; stdout: string }
export type InstallAdapters = {
  systemctl: (args: readonly string[]) => Promise<CommandResult>
  portAvailable: (host: string, port: number) => Promise<boolean>
  ready: (origin: string, token: string) => Promise<boolean>
}
export type InstallOptions = {
  root: string
  node: string
  env?: NodeJS.ProcessEnv
  adapters?: Partial<InstallAdapters>
  readinessAttempts?: number
  readinessDelayMs?: number
}

type Paths = {
  root: string; node: string; home: string; base: string; secretDir: string; env: string
  unit: string; config: string; clients: string; command: string; enabledLink: string
}
type Snapshot = { path: string; stat: Stats; data?: Buffer; target?: string }
type ServiceState = { active: boolean; enabled: boolean }
type Plan = {
  paths: Paths; snapshots: Map<string, Snapshot | undefined>; service: ServiceState
  config?: Config; configSource?: string; keys: string[]; name: string; token?: string
  launcher: string; origin: string; host: string; port: number
}

function absolutePath(value: string | undefined): string {
  if (!value || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) fail('Installer paths must be absolute and contain no control characters.')
  return resolve(value)
}
function pathsFor(options: InstallOptions): Paths {
  const env = options.env ?? process.env
  const home = absolutePath(env.HOME)
  const base = absolutePath(env.XDG_CONFIG_HOME || join(home, '.config'))
  const root = absolutePath(options.root)
  const node = absolutePath(options.node)
  return {
    root, node, home, base, secretDir: join(base, 'cc-gateway'), env: join(base, 'cc-gateway/server.env'),
    unit: join(base, 'systemd/user', UNIT), config: join(root, 'config.yaml'), clients: join(root, 'clients'),
    command: join(home, '.local/bin/c'), enabledLink: join(base, 'systemd/user/default.target.wants', UNIT),
  }
}
function maybeStat(path: string): Stats | undefined {
  try { return lstatSync(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
}
function sameInode(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino }
function checkDirectories(path: string, owned = false): void {
  const parent = dirname(path)
  if (parent !== path) checkDirectories(parent)
  const stat = maybeStat(path)
  if (!stat) return
  const uid = process.getuid!()
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== uid && stat.uid !== 0)
    || (owned && stat.uid !== uid)
    || ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000)))) {
    fail('Installer directories must be owned, real directories without shared write access.')
  }
}
function snapshot(path: string, symlink = false): Snapshot | undefined {
  checkDirectories(dirname(path))
  const stat = maybeStat(path)
  if (!stat) return
  if (stat.uid !== process.getuid!()) fail('Refusing a file owned by another user.')
  if (symlink && stat.isSymbolicLink()) return { path, stat, target: readlinkSync(path) }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_FILE) {
    fail('Installer files must be regular files without symlinks or hard links.')
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!sameInode(stat, fstatSync(fd))) fail('Installation files changed during inspection.')
    return { path, stat, data: readFileSync(fd) }
  } finally { closeSync(fd) }
}
function assertUnchanged(path: string, before: Snapshot | undefined): void {
  const now = snapshot(path, true)
  if (!before && !now) return
  if (!before || !now || !sameInode(before.stat, now.stat) || before.stat.mode !== now.stat.mode
    || before.target !== now.target || (before.data && !before.data.equals(now.data ?? Buffer.alloc(0)))) {
    fail('Installation files changed; refusing to overwrite them.')
  }
}

function credential(key: string): string {
  if (!key || /[^\x21-\x7e]/.test(key) || key.length > 16384) fail('The API key must be printable ASCII without whitespace.')
  return key
}
function parseEnvValue(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) fail('The credential file has an unsupported format.')
  let key = ''
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) fail('The credential file has an unsupported format.')
    const body = value.slice(1, -1)
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '"') fail('The credential file has an unsupported format.')
      if (body[i] === '\\') {
        const next = body[++i]
        if (!next || !['\\', '"', '$', '`'].includes(next)) fail('The credential file has an unsupported format.')
        key += next
      } else key += body[i]
    }
  } else if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.slice(1, -1).includes("'")) fail('The credential file has an unsupported format.')
    key = value.slice(1, -1)
  } else {
    if (/[\s\\'"`]/.test(value)) fail('The credential file has an unsupported format.')
    key = value
  }
  return key
}
function validateKeys(keys: unknown): string[] {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 8 || keys.some(key => typeof key !== 'string')) fail('The installation requires between one and eight API keys.')
  const result = keys.map(key => credential(key))
  if (new Set(result).size !== result.length) fail('API keys must not be duplicated.')
  return result
}
export function parseServerKeys(source: string): string[] {
  // Only these assignments are accepted; EnvironmentFile contents are never evaluated.
  const values = new Map<string, string>()
  for (const line of source.split('\n').filter(line => line !== '' && !line.startsWith('#'))) {
    const at = line.indexOf('=')
    const name = line.slice(0, at)
    if (!['CC_GATEWAY_UPSTREAM_API_KEY', 'CC_GATEWAY_FALLBACK_API_KEYS'].includes(name) || values.has(name)) fail('The credential file has an unsupported format.')
    values.set(name, parseEnvValue(line.slice(at + 1)))
  }
  const primary = values.get('CC_GATEWAY_UPSTREAM_API_KEY')
  if (!primary) fail('The credential file has no primary API key.')
  let fallbacks: unknown = []
  try { if (values.has('CC_GATEWAY_FALLBACK_API_KEYS')) fallbacks = JSON.parse(values.get('CC_GATEWAY_FALLBACK_API_KEYS')!) }
  catch { fail('The fallback credential list is invalid.') }
  if (!Array.isArray(fallbacks)) fail('The fallback credential list is invalid.')
  return validateKeys([primary, ...fallbacks])
}
export function parseServerEnv(source: string): string { return parseServerKeys(source)[0] }
function envQuote(value: string): string { return `"${value.replace(/[\\"$`]/g, '\\$&')}"` }
export function renderServerKeys(keys: string[]): string {
  validateKeys(keys)
  return `${MARKER}\nCC_GATEWAY_UPSTREAM_API_KEY=${envQuote(keys[0])}\n${keys.length > 1 ? `CC_GATEWAY_FALLBACK_API_KEYS=${envQuote(JSON.stringify(keys.slice(1)))}\n` : ''}`
}
export function renderServerEnv(key: string): string { return renderServerKeys([key]) }
function legacyUnit(source: string, paths: Paths): boolean {
  if (/[\r\x00]/.test(source) || /[\s%"'\\]/.test(paths.root) || /[\s%"'\\]/.test(paths.env)) return false
  const required: Record<string, string> = {
    'Unit.Description': 'Local Claude Code privacy gateway',
    'Service.WorkingDirectory': paths.root,
    'Service.EnvironmentFile': paths.env,
    'Service.ExecStart': `/usr/local/bin/node ${join(paths.root, 'dist/index.js')} ${paths.config}`,
    'Service.Restart': 'on-failure', 'Service.RestartSec': '3', 'Service.TimeoutStopSec': '10',
    'Service.UMask': '0077', 'Service.NoNewPrivileges': 'true', 'Install.WantedBy': 'default.target',
    'Unit.After': 'network-online.target', 'Service.Type': 'simple',
    'Service.Environment': 'NODE_TLS_REJECT_UNAUTHORIZED=1',
  }
  const optional: Record<string, string> = {}
  const seen = new Set<string>()
  let section = ''
  for (const line of source.split('\n')) {
    if (!line || line.startsWith('#')) continue
    if (/^\[(Unit|Service|Install)\]$/.test(line)) { section = line.slice(1, -1); continue }
    const match = /^([A-Za-z]+)=(.*)$/.exec(line)
    if (!match) return false
    const key = `${section}.${match[1]}`
    if (seen.has(key) || (required[key] ?? optional[key]) !== match[2]) return false
    seen.add(key)
  }
  return Object.keys(required).every(key => seen.has(key))
}
function systemdQuote(value: string, exec = false): string {
  absolutePath(value)
  const quoted = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')
  return `"${exec ? quoted.replace(/\$/g, '$$$$') : quoted}"`
}
// WorkingDirectory= and EnvironmentFile= read the whole value as a path, so quotes would become part of it.
function systemdPath(value: string): string {
  absolutePath(value)
  return value.replace(/%/g, '%%')
}
function systemdUnquote(quoted: string): string {
  const escapes: Record<string, string> = { '\\\\': '\\', '\\"': '"', '%%': '%', '$$': '$' }
  return quoted.slice(1, -1).replace(/\\\\|\\"|%%|\$\$/g, match => escapes[match])
}
function ownedUnit(source: string, paths: Paths): boolean {
  const match = /^ExecStart=("(?:[^"\\\n]|\\.)*") /m.exec(source)
  if (!match) return false
  const node = systemdUnquote(match[1])
  try { absolutePath(node) } catch { return false }
  return source === renderServiceUnit(paths.root, node, paths.env)
}
function installedPaths(source: string, requested: Paths): Paths | undefined {
  const match = /^WorkingDirectory=(.+)$/m.exec(source)
  if (!match) return
  let root: string
  try { root = absolutePath(match[1].replaceAll('%%', '%')) } catch { return }
  const paths = { ...requested, root, config: join(root, 'config.yaml'), clients: join(root, 'clients') }
  // Extracting a path does not establish ownership; the entire unit must match.
  if (ownedUnit(source, paths) || legacyUnit(source, paths)) return paths
}
// The generated header and token line identify a launcher; later launcher revisions are upgraded in place.
function recognizedLauncher(source: string, token: string): boolean {
  return source.startsWith('#!/usr/bin/env bash\n# This file contains a gateway client token.')
    && source.includes(`\nexport ANTHROPIC_API_KEY='${token.replaceAll("'", "'\\''")}'\n`)
}
function defaultSystemctl(env: NodeJS.ProcessEnv): InstallAdapters['systemctl'] {
  const childEnv: NodeJS.ProcessEnv = { ...env, LC_ALL: 'C', SYSTEMD_COLORS: '0' }
  delete childEnv.CC_GATEWAY_UPSTREAM_API_KEY
  delete childEnv.CC_GATEWAY_FALLBACK_API_KEYS
  delete childEnv.ANTHROPIC_API_KEY
  return args => new Promise(resolveResult => {
    execFile('/usr/bin/systemctl', ['--user', '--no-pager', ...args], {
      env: childEnv, timeout: SYSTEMCTL_TIMEOUT, killSignal: 'SIGKILL', maxBuffer: 65536,
    }, (error, stdout) => resolveResult({ code: error ? 1 : 0, stdout: String(stdout) }))
  })
}
function portAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolveResult, reject) => {
    const server = createServer()
    const timer = setTimeout(() => { server.close(); reject(new InstallError('Local port inspection timed out.')) }, TIMEOUT)
    server.once('error', error => {
      clearTimeout(timer)
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') resolveResult(false)
      else reject(new InstallError('Unable to inspect the configured local port.'))
    })
    server.listen({ host, port, exclusive: true }, () => server.close(() => { clearTimeout(timer); resolveResult(true) }))
  })
}
function localJson(url: string, token?: string): Promise<Record<string, unknown> | undefined> {
  return new Promise(resolveResult => {
    let settled = false
    const finish = (value?: Record<string, unknown>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveResult(value)
    }
    const req = request(url, { method: 'GET', agent: false, headers: token ? { 'x-api-key': token } : {} }, res => {
      const chunks: Buffer[] = []
      let length = 0
      res.on('data', (chunk: Buffer) => {
        length += chunk.length
        if (length > 65536) { req.destroy(); finish(); return }
        chunks.push(chunk)
      })
      res.on('error', () => finish())
      res.on('end', () => {
        if (res.statusCode !== 200) { finish(); return }
        try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { finish() }
      })
    })
    const timer = setTimeout(() => { req.destroy(); finish() }, TIMEOUT)
    req.on('error', () => finish())
    req.end()
  })
}
async function ready(origin: string, token: string): Promise<boolean> {
  const health = await localJson(`${origin}/_health`)
  if (health?.status !== 'ok') return false
  const verification = await localJson(`${origin}/agent-v2/_verify`, token)
  return verification?.profile === 'neutral-v2'
}
function adaptersFor(options: InstallOptions): InstallAdapters {
  return { systemctl: defaultSystemctl(options.env ?? process.env), portAvailable, ready, ...options.adapters }
}
async function inspectService(paths: Paths, unit: Snapshot | undefined, adapters: InstallAdapters): Promise<ServiceState> {
  if ((await adapters.systemctl(['show', '--property=Version', '--value'])).code !== 0) {
    fail('The systemd user manager is unavailable.')
  }
  const result = await adapters.systemctl(['show', UNIT, '--property=LoadState,FragmentPath,DropInPaths,ActiveState,UnitFileState'])
  const values: Record<string, string> = {}
  for (const line of result.stdout.trim().split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) values[line.slice(0, at)] = line.slice(at + 1)
  }
  if (result.code !== 0 && values.LoadState !== 'not-found') fail('Unable to inspect the gateway user service.')
  if (values.DropInPaths || (values.FragmentPath && values.FragmentPath !== paths.unit)) fail('Refusing a foreign gateway service or service override.')
  if (!unit && (values.LoadState !== 'not-found' || values.ActiveState !== 'inactive')) fail('Refusing a gateway service outside this installation.')
  if (unit && !['loaded', 'not-found'].includes(values.LoadState)) fail('The gateway service cannot be safely updated.')
  if (!['active', 'inactive', 'failed'].includes(values.ActiveState)
    || !['', 'enabled', 'disabled'].includes(values.UnitFileState ?? '')) fail('The gateway service has an unsupported state.')
  return { active: values.ActiveState === 'active', enabled: values.UnitFileState === 'enabled' }
}
function readConfig(source: string, key = DUMMY_KEY): Config {
  try {
    const doc = parseDocument(source)
    if (doc.errors.length) fail('The existing gateway configuration is invalid.')
    return parseConfig(doc.toJS({ maxAliasCount: 100 }), { CC_GATEWAY_UPSTREAM_API_KEY: key })
  } catch { fail('The existing gateway configuration is invalid.') }
}
function checkCommandSearch(paths: Paths, env: NodeJS.ProcessEnv, launcher: string): void {
  for (const directory of (env.PATH ?? '').split(':').filter(Boolean)) {
    if (!isAbsolute(directory)) fail('PATH must contain only absolute command directories.')
    const candidate = join(directory, 'c')
    if (resolve(candidate) === paths.command) continue
    let stat: Stats | undefined
    // An unreadable or non-directory PATH entry cannot supply a command, so it is not a conflict.
    try { stat = maybeStat(candidate) } catch { continue }
    if (stat && (!stat.isSymbolicLink() || resolve(dirname(candidate), readlinkSync(candidate)) !== launcher)) {
      fail('Another c command is present in PATH; resolve it before installing.')
    }
  }
}
async function inspect(options: InstallOptions, adapters: InstallAdapters, lockRoot?: (root: string) => void): Promise<Plan> {
  const requested = pathsFor(options)
  checkDirectories(requested.root, true)
  if (!maybeStat(requested.root)?.isDirectory()) fail('The checkout directory must exist.')
  const unit = snapshot(requested.unit)
  const paths = unit ? installedPaths(unit.data!.toString('utf8'), requested) : requested
  if (!paths) fail('Refusing to overwrite an unrecognized gateway service.')
  for (const path of [paths.root, paths.home, paths.base, paths.secretDir, dirname(paths.unit), dirname(paths.command), paths.clients, dirname(paths.enabledLink)]) checkDirectories(path, true)
  if (!maybeStat(paths.root)?.isDirectory() || !maybeStat(paths.home)?.isDirectory()) fail('The checkout and HOME directories must exist.')
  const realNode = realpathSync(paths.node)
  checkDirectories(dirname(realNode))
  const executable = statSync(realNode)
  if (!executable.isFile() || !(executable.mode & 0o111) || (executable.mode & 0o022)
    || ![0, process.getuid!()].includes(executable.uid)) fail('The Node executable is not a trusted executable file.')
  const secretDirectory = maybeStat(paths.secretDir)
  if (secretDirectory && (secretDirectory.mode & 0o777) !== 0o700) fail('The credential directory must have mode 700.')
  lockRoot?.(paths.root)
  const snapshots = new Map<string, Snapshot | undefined>([[paths.unit, unit]])
  for (const path of [paths.config, paths.env]) snapshots.set(path, snapshot(path))
  const keys = snapshots.get(paths.env) ? parseServerKeys(snapshots.get(paths.env)!.data!.toString('utf8')) : []
  const configSource = snapshots.get(paths.config)?.data?.toString('utf8')
  const config = configSource === undefined ? undefined : readConfig(configSource, keys[0])
  if (config?.auth.tokens.some(entry => keys.includes(entry.token))) fail('Client tokens must differ from all upstream API keys.')
  if (!config && (keys.length || unit)) fail('An existing installation is missing its gateway configuration.')
  const host = config?.server.host ?? '127.0.0.1'
  const port = config?.server.port ?? 8443
  if (!(host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'))) || port === 0) fail('The installer requires a loopback listener with a fixed port.')
  if (config?.server.tls) fail('TLS configurations require manual service setup; no files were changed.')
  const origin = `http://${host === '::1' ? '[::1]' : host}:${port}`
  const command = snapshot(paths.command, true)
  snapshots.set(paths.command, command)
  let name = 'local'
  if (command) {
    if (!command.target) fail('Refusing to overwrite an existing c command.')
    const target = resolve(dirname(paths.command), command.target)
    if (dirname(target) !== paths.clients || !/^cc-[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(target.slice(paths.clients.length + 1))) fail('The c command belongs to another installation.')
    name = target.slice(paths.clients.length + 4)
  }
  const token = config?.auth.tokens.find(entry => entry.name === name)?.token
  if (config && !token) fail('The existing configuration has no matching installer client.')
  const launcher = join(paths.clients, `cc-${name}`)
  const existingLauncher = snapshot(launcher)
  snapshots.set(launcher, existingLauncher)
  if (existingLauncher) {
    if (!token) fail('An existing client launcher has no matching configuration.')
    if (!recognizedLauncher(existingLauncher.data!.toString('utf8'), token)) fail('Refusing to overwrite an unrecognized client launcher.')
  }
  const enabledLink = snapshot(paths.enabledLink, true)
  if (enabledLink && (!enabledLink.target || resolve(dirname(paths.enabledLink), enabledLink.target) !== paths.unit)) fail('Refusing a foreign service enablement link.')
  checkCommandSearch(paths, options.env ?? process.env, launcher)
  const service = await inspectService(paths, unit, adapters)
  if (!await adapters.portAvailable(host, port)) {
    if (!unit || !service.active || !token || !await adapters.ready(origin, token)) fail('The configured port is occupied by an unverified service.')
  }
  return { paths, snapshots, service, config, configSource, keys, name, token, launcher, origin, host, port }
}

export async function preflightInstall(options: InstallOptions): Promise<'key-present' | 'key-required'> {
  try { return (await inspect(options, adaptersFor(options))).keys.length ? 'key-present' : 'key-required' }
  catch (error) { throw safeError(error) }
}

type Change = { path: string; before?: Snapshot; after: Snapshot }
function atomicWrite(path: string, before: Snapshot | undefined, data: Buffer | string, mode: number, target?: string): Snapshot {
  checkDirectories(dirname(path), true)
  assertUnchanged(path, before)
  const temporary = join(dirname(path), `.cc-gateway-${randomBytes(12).toString('hex')}.tmp`)
  if (target !== undefined) symlinkSync(target, temporary)
  else {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
    try { fchmodSync(fd, mode); writeFileSync(fd, data); fsyncSync(fd) }
    catch (error) { unlinkSync(temporary); throw error }
    finally { closeSync(fd) }
  }
  try {
    assertUnchanged(path, before)
    if (before) renameSync(temporary, path)
    else linkSync(temporary, path)
  } finally { if (maybeStat(temporary)) unlinkSync(temporary) }
  return snapshot(path, target !== undefined)!
}
function ensureDirectory(path: string, created: Snapshot[]): void {
  checkDirectories(path, true)
  if (maybeStat(path)) return
  ensureDirectory(dirname(path), created)
  mkdirSync(path, { mode: 0o700 })
  created.push({ path, stat: lstatSync(path) })
}
async function serviceCommand(adapters: InstallAdapters, args: string[]): Promise<void> {
  if ((await adapters.systemctl(args)).code !== 0) fail('The gateway service operation failed.')
}
async function waitReady(plan: Plan, token: string, options: InstallOptions, adapters: InstallAdapters): Promise<void> {
  const attempts = options.readinessAttempts ?? 12
  const delay = options.readinessDelayMs ?? 250
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 60 || !Number.isInteger(delay) || delay < 0 || delay > 1000) fail('Invalid readiness limits.')
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await adapters.ready(plan.origin, token)) return
    if (attempt + 1 < attempts) await new Promise(resolveDelay => setTimeout(resolveDelay, delay))
  }
  fail('The gateway did not pass its local readiness checks.')
}
async function rollback(plan: Plan, changes: Change[], created: Snapshot[], adapters: InstallAdapters, serviceTouched: boolean): Promise<boolean> {
  let restored = true
  const attempt = async (action: () => void | Promise<void>) => {
    try { await action() } catch { restored = false }
  }
  if (serviceTouched) {
    const unitChange = changes.find(change => change.path === plan.paths.unit)
    try { assertUnchanged(plan.paths.unit, unitChange?.after ?? plan.snapshots.get(plan.paths.unit)) }
    catch { return false }
    await attempt(() => serviceCommand(adapters, ['stop', UNIT]))
    if (!plan.service.enabled) await attempt(() => serviceCommand(adapters, ['disable', UNIT]))
  }
  for (const change of [...changes].reverse()) {
    await attempt(() => {
      assertUnchanged(change.path, change.after)
      if (change.before) atomicWrite(change.path, change.after, change.before.data ?? '', change.before.stat.mode & 0o7777, change.before.target)
      else unlinkSync(change.path)
    })
  }
  if (serviceTouched) {
    await attempt(() => serviceCommand(adapters, ['daemon-reload']))
    if (plan.service.enabled) await attempt(() => serviceCommand(adapters, ['enable', UNIT]))
    if (plan.service.active && restored) await attempt(() => serviceCommand(adapters, ['restart', UNIT]))
  }
  for (const directory of [...created].reverse()) {
    try {
      const now = maybeStat(directory.path)
      if (now?.isDirectory() && sameInode(now, directory.stat)) rmdirSync(directory.path)
    } catch (error) {
      if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) restored = false
    }
  }
  return restored
}

type KeyAction = { kind: 'apply' } | { kind: 'add' } | { kind: 'remove'; index: number }
function requireInstalled(plan: Plan): void {
  if (!plan.config || !plan.keys.length || !plan.snapshots.get(plan.paths.unit)) fail('Key management requires an existing managed installation.')
}
export async function listInstallKeys(options: InstallOptions): Promise<Array<{ index: number; role: 'primary' | 'fallback' }>> {
  try {
    const plan = await inspect(options, adaptersFor(options))
    requireInstalled(plan)
    return plan.keys.map((_, index) => ({ index: index + 1, role: index === 0 ? 'primary' : 'fallback' }))
  } catch (error) { throw safeError(error) }
}
export function applyInstall(options: InstallOptions, stdinKey: string): Promise<void> {
  return applyChange(options, stdinKey, { kind: 'apply' })
}
export function addInstallKey(options: InstallOptions, stdinKey: string): Promise<void> {
  return applyChange(options, stdinKey, { kind: 'add' })
}
export function removeInstallKey(options: InstallOptions, index: number): Promise<void> {
  return applyChange(options, '', { kind: 'remove', index })
}
async function applyChange(options: InstallOptions, stdinKey: string, action: KeyAction): Promise<void> {
  const locks = new Map<string, { fd: number; file?: Snapshot }>()
  const acquireLock = (path: string) => {
    if (locks.has(path)) return
    checkDirectories(dirname(path), true)
    let fd: number
    try { fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600) }
    catch { fail('Another setup operation holds the installation lock.') }
    const lock: { fd: number; file?: Snapshot } = { fd }
    locks.set(path, lock)
    lock.file = snapshot(path)
  }
  const lockRoot = (root: string) => acquireLock(join(root, 'config.yaml.lock'))
  try {
    const requested = pathsFor(options)
    // Every checkout shares the same credentials, service and c command.
    acquireLock(join(requested.home, '.cc-gateway-install.lock'))
    if (action.kind === 'apply') lockRoot(requested.root)
    const adapters = adaptersFor(options)
    const plan = await inspect(options, adapters, lockRoot)
    const paths = action.kind === 'apply' ? requested : plan.paths
    const supplied = stdinKey.endsWith('\n') ? stdinKey.slice(0, -1) : stdinKey
    if (action.kind !== 'apply') requireInstalled(plan)
    let keys = [...plan.keys]
    if (action.kind === 'remove') {
      if (!Number.isSafeInteger(action.index) || action.index < 1 || action.index > keys.length) fail('The key index is out of range.')
      if (keys.length === 1) fail('The last API key cannot be removed.')
      keys.splice(action.index - 1, 1)
    } else if (action.kind === 'add') keys.push(credential(supplied))
    else if (supplied) keys = [credential(supplied), ...keys.slice(1)]
    if (!keys.length) fail('An API key is required on standard input.')
    keys = validateKeys(keys)
    const initial = plan.config ? undefined : createSetupFiles(plan.name)
    const token = plan.token ?? initial!.token
    const configSource = plan.configSource ?? initial!.config
    const configData = plan.snapshots.get(plan.paths.config)?.data ?? Buffer.from(configSource)
    const config = readConfig(configSource, keys[0])
    if (config.auth.tokens.some(entry => keys.includes(entry.token))) fail('Client tokens must differ from all upstream API keys.')
    const launcher = join(paths.clients, `cc-${plan.name}`)
    if (paths.root !== plan.paths.root) {
      checkCommandSearch(paths, options.env ?? process.env, launcher)
      checkDirectories(paths.clients, true)
      const destinationConfig = snapshot(paths.config)
      if (destinationConfig && !destinationConfig.data!.equals(configData)) fail('The destination checkout has a different gateway configuration.')
      const destinationLauncher = snapshot(launcher)
      if (destinationLauncher && !recognizedLauncher(destinationLauncher.data!.toString('utf8'), token)) fail('Refusing to overwrite an unrecognized client launcher.')
      plan.snapshots.set(paths.config, destinationConfig)
      plan.snapshots.set(launcher, destinationLauncher)
    }
    const entrypoint = snapshot(join(paths.root, 'dist/index.js'))
    if (!entrypoint) fail('Build the gateway before applying the installation.')
    const changes: Change[] = []
    const created: Snapshot[] = []
    let serviceTouched = false
    const write = (path: string, data: Buffer | string, mode: number, target?: string) => {
      const before = plan.snapshots.get(path)
      assertUnchanged(path, before)
      if (before && before.target === target && (target !== undefined || (before.data?.equals(Buffer.from(data)) && (before.stat.mode & 0o7777) === mode))) return
      const after = atomicWrite(path, before, data, mode, target)
      changes.push({ path, before, after })
    }
    try {
      for (const [path, before] of plan.snapshots) assertUnchanged(path, before)
      const directories = action.kind === 'apply' ? [paths.secretDir, dirname(paths.unit), dirname(paths.command), paths.clients] : [paths.secretDir]
      for (const directory of directories) ensureDirectory(directory, created)
      write(paths.env, renderServerKeys(keys), 0o600)
      if (action.kind === 'apply') {
        if (!plan.snapshots.get(paths.config)) write(paths.config, configData, 0o600)
        write(launcher, renderLauncher(token, plan.origin), 0o700)
        write(paths.command, '', 0o777, launcher)
        write(paths.unit, renderServiceUnit(paths.root, paths.node, paths.env), 0o644)
      }
      serviceTouched = true
      await serviceCommand(adapters, ['daemon-reload'])
      if (action.kind === 'apply') await serviceCommand(adapters, ['enable', UNIT])
      await serviceCommand(adapters, ['restart', UNIT])
      await waitReady(plan, token, options, adapters)
    } catch (error) {
      if (!await rollback(plan, changes, created, adapters, serviceTouched)) fail('Installation failed and rollback was incomplete; inspect the gateway service before retrying.')
      throw error
    }
  } catch (error) { throw safeError(error) }
  finally {
    for (const { fd, file } of [...locks.values()].reverse()) {
      closeSync(fd)
      if (file) {
        try { assertUnchanged(file.path, file); unlinkSync(file.path) } catch { /* A replacement lock belongs to its new owner. */ }
      }
    }
  }
}

export type InstallCommand = 'preflight' | 'apply' | 'add-key' | 'list-keys' | 'remove-key'
export function parseInstallArgs(args: string[]): { command: InstallCommand; root: string; node: string; index?: number } {
  const command = args[0] as InstallCommand
  if (!['preflight', 'apply', 'add-key', 'list-keys', 'remove-key'].includes(command)
    || args.length !== (command === 'remove-key' ? 7 : 5)) fail('Usage: install.ts <action> --root <absolute checkout> --node <absolute node> [--index N]')
  const values: Record<string, string> = {}
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index]
    const allowed = flag === '--root' || flag === '--node' || (flag === '--index' && command === 'remove-key')
    if (!allowed || values[flag] !== undefined || !args[index + 1]) fail('Invalid installer arguments.')
    values[flag] = flag === '--index' ? args[index + 1] : absolutePath(args[index + 1])
  }
  if (!values['--root'] || !values['--node']) fail('Both --root and --node are required.')
  if (command === 'remove-key' && !/^[1-8]$/.test(values['--index'] ?? '')) fail('The key index must be between 1 and 8.')
  return { command, root: values['--root'], node: values['--node'], ...(command === 'remove-key' ? { index: Number(values['--index']) } : {}) }
}
async function readKeyInput(): Promise<string> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.length
    if (length > 16385) fail('The standard input credential is too large.')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}
async function main(args: string[]): Promise<void> {
  const { command, index, ...options } = parseInstallArgs(args)
  if (command === 'preflight') console.log(await preflightInstall(options))
  else if (command === 'list-keys') {
    const keys = await listInstallKeys(options)
    console.log(`Keys: ${keys.length}`)
    for (const key of keys) console.log(`${key.index} ${key.role}`)
  } else if (command === 'add-key' || command === 'remove-key') {
    if (command === 'add-key') await addInstallKey(options, await readKeyInput())
    else await removeInstallKey(options, index!)
    console.log('API key list updated; gateway verified locally.')
  } else {
    await applyInstall(options, await readKeyInput())
    console.log('Gateway installed and verified. Run c to start Claude Code through the gateway.')
    console.log('If c is not on PATH, add $HOME/.local/bin to PATH. No shell profile was changed.')
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Installer: ${safeError(error).message}`)
    process.exitCode = 1
  })
}

export function renderServiceUnit(root: string, node: string, envFile: string): string {
  return `${MARKER}\n[Unit]\nDescription=Local Claude Code privacy gateway\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${systemdPath(root)}\nEnvironmentFile=${systemdPath(envFile)}\nEnvironment=NODE_TLS_REJECT_UNAUTHORIZED=1\nExecStart=${systemdQuote(node, true)} ${systemdQuote(join(root, 'dist/index.js'), true)} ${systemdQuote(join(root, 'config.yaml'), true)}\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=10\nUMask=0077\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`
}
