import { randomBytes } from 'node:crypto'
import {
  chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, linkSync,
  lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseDocument, stringify } from 'yaml'
import { parseConfig } from '../config.js'

const DEFAULT_GATEWAY = 'http://127.0.0.1:8443'
const CLIENT_FLAGS = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
  CLAUDE_CODE_DISABLE_FAST_MODE: '1',
  CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1',
  CLAUDE_CODE_GATEWAY_HINT_HEADERS: '0',
  CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
}

function validateName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) {
    throw new Error('Client name must contain 1-64 letters, digits, dots, underscores or hyphens and start with a letter or digit')
  }
}

function normalizeGateway(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Gateway URL must be an HTTP(S) origin')
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
  if (value !== value.trim() || /[\x00-\x20\x7f]/.test(value) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Gateway URL must be an origin without credentials, path, query or fragment')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Remote gateways require HTTPS; HTTP is allowed only on loopback')
  }
  return url.origin
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function renderLauncher(token: string, gateway: string): string {
  if (!token || /[\x00-\x20\x7f]/.test(token)) throw new Error('Client token must be nonempty and contain no whitespace or control characters')
  const url = `${normalizeGateway(gateway)}/agent-v2`
  const flags = Object.entries(CLIENT_FLAGS).map(([name, value]) => `export ${name}=${value}`).join('\n')
  // The CLI records which API keys the user approved by their last 20 characters.
  // Only a plain suffix is embedded, so the seeded JSON can never be malformed.
  const approval = token.slice(-20)
  const seed = /^[A-Za-z0-9_-]+$/.test(approval)
    ? `if [[ ! -e "$profile/.claude.json" ]]; then
  ( umask 077; printf '{"hasCompletedOnboarding":true,"customApiKeyResponses":{"approved":["%s"],"rejected":[]}}\\n' ${shellQuote(approval)} > "$profile/.claude.json" )
fi
`
    : ''
  return `#!/usr/bin/env bash
# This file contains a gateway client token. Keep it private.
set -euo pipefail

unset ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN CC_GATEWAY_UPSTREAM_API_KEY
unset ANTHROPIC_CUSTOM_HEADERS CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY
unset CLAUDE_CODE_ENABLE_TELEMETRY NODE_TLS_REJECT_UNAUTHORIZED
export ANTHROPIC_API_KEY=${shellQuote(token)}
export ANTHROPIC_BASE_URL=${shellQuote(url)}
${flags}

# A gateway session gets its own profile. Sharing a directory with a claude.ai login makes
# the CLI warn that two credentials are set. The login itself is never read or copied.
profile="\${CC_GATEWAY_CLAUDE_CONFIG_DIR:-\${XDG_DATA_HOME:-$HOME/.local/share}/cc-gateway/claude}"
case "$profile" in /*) ;; *) printf '%s\\n' 'The Claude profile directory must be an absolute path.' >&2; exit 1 ;; esac
mkdir -p -m 700 -- "$profile"
${seed}export CLAUDE_CONFIG_DIR="$profile"

exec claude "$@"
`
}

function ensureDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Setup directories must be real directories, not symlinks')
}

function withLock<T>(directory: string, action: () => T): T {
  if (!lstatSync(directory).isDirectory()) throw new Error('Setup directory must exist')
  const path = join(directory, 'config.yaml.lock')
  let fd: number
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('config.yaml is locked by another setup operation; inspect config.yaml.lock before removing a stale lock')
    throw error
  }
  try {
    return action()
  } finally {
    closeSync(fd)
    unlinkSync(path)
  }
}

function writePrivate(path: string, contents: string, mode: number, replace = false): void {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`
  const fd = openSync(temporary, 'wx', mode)
  try {
    fchmodSync(fd, mode)
    writeFileSync(fd, contents)
    fsyncSync(fd)
  } catch (error) {
    closeSync(fd)
    unlinkSync(temporary)
    throw error
  }
  closeSync(fd)
  try {
    if (replace) renameSync(temporary, path)
    else linkSync(temporary, path)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

function prepareLauncher(directory: string, name: string, token: string, gateway: string): string {
  const clients = join(directory, 'clients')
  ensureDirectory(clients)
  chmodSync(clients, 0o700)
  const path = join(clients, `cc-${name}`)
  writePrivate(path, renderLauncher(token, gateway), 0o700)
  return path
}

function validateSetupConfig(value: unknown) {
  // Setup validates the schema without loading or persisting an upstream credential.
  return parseConfig(value, { CC_GATEWAY_UPSTREAM_API_KEY: randomBytes(32).toString('hex') })
}

export function createSetupFiles(name = 'local', docker = false): { config: string; token: string; launcher: string } {
  validateName(name)
  const token = randomBytes(32).toString('hex')
  const config = {
    server: { host: docker ? '0.0.0.0' : '127.0.0.1', port: 8443 },
    upstream: { url: 'https://api.anthropic.com', user_agent: 'opencode/1.18.35' },
    auth: { tokens: [{ name, token }] },
    logging: { level: 'info', audit: false },
  }
  validateSetupConfig(config)
  return { config: stringify(config), token, launcher: renderLauncher(token, DEFAULT_GATEWAY) }
}

export function createSetup(directory: string, name = 'local', docker = false): string {
  const files = createSetupFiles(name, docker)
  return withLock(directory, () => {
    const configPath = join(directory, 'config.yaml')
    try {
      lstatSync(configPath)
      throw new Error('config.yaml already exists; use add-client or start the existing gateway')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const launcher = prepareLauncher(directory, name, files.token, DEFAULT_GATEWAY)
    try {
      writePrivate(configPath, files.config, 0o600)
    } catch (error) {
      unlinkSync(launcher)
      throw error
    }
    return launcher
  })
}

export function addClient(directory: string, name: string, gateway = DEFAULT_GATEWAY): string {
  validateName(name)
  const url = normalizeGateway(gateway)
  return withLock(directory, () => {
    const path = join(directory, 'config.yaml')
    if (!lstatSync(path).isFile()) throw new Error('config.yaml must be a regular file')
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let source: string
    let inode: number
    try {
      inode = fstatSync(fd).ino
      source = readFileSync(fd, 'utf8')
    } finally {
      closeSync(fd)
    }
    const document = parseDocument(source)
    if (document.errors.length) throw new Error('config.yaml contains invalid YAML')
    let value: unknown
    try {
      value = document.toJS({ maxAliasCount: 100 })
    } catch {
      throw new Error('config.yaml contains invalid YAML aliases')
    }
    const config = validateSetupConfig(value)
    if (config.auth.tokens.some(entry => entry.name === name)) throw new Error('A client with this name already exists')
    const token = randomBytes(32).toString('hex')
    document.addIn(['auth', 'tokens'], { name, token })
    validateSetupConfig(document.toJS({ maxAliasCount: 100 }))
    const launcher = prepareLauncher(directory, name, token, url)
    try {
      const current = lstatSync(path)
      if (!current.isFile() || current.ino !== inode || readFileSync(path, 'utf8') !== source) {
        throw new Error('config.yaml changed during setup; no configuration was replaced')
      }
      writePrivate(path, document.toString(), 0o600, true)
    } catch (error) {
      unlinkSync(launcher)
      throw error
    }
    return launcher
  })
}

export function refreshClient(directory: string, name: string, gateway = DEFAULT_GATEWAY): string {
  validateName(name)
  const url = normalizeGateway(gateway)
  return withLock(directory, () => {
    const configPath = join(directory, 'config.yaml')
    const fd = openSync(configPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    let value: unknown
    try { value = parseDocument(readFileSync(fd, 'utf8')).toJS({ maxAliasCount: 100 }) }
    catch { throw new Error('Unable to read client configuration') }
    finally { closeSync(fd) }
    const config = validateSetupConfig(value)
    const entry = config.auth.tokens.find(entry => entry.name === name)
    if (!entry) throw new Error('Unknown client name')
    const clients = join(directory, 'clients')
    if (!lstatSync(clients).isDirectory()) throw new Error('Client directory must be a real directory')
    const path = join(clients, `cc-${name}`)
    if (!lstatSync(path).isFile()) throw new Error('Client launcher must be a regular file')
    const source = readFileSync(path, 'utf8')
    if (!source.startsWith('#!/usr/bin/env bash\n# This file contains a gateway client token.')
      || !source.includes(`export ANTHROPIC_API_KEY=${shellQuote(entry.token)}\n`)) {
      throw new Error('Refusing to overwrite an unrecognized client launcher')
    }
    writePrivate(path, renderLauncher(entry.token, url), 0o700, true)
    return path
  })
}

function main(args: string[]): void {
  const command = args.shift()
  if (!command || command === '--help') {
    console.log('Usage: setup.ts init [name] [--docker] [--directory path]\n       setup.ts add-client <name> [gateway-url] [--directory path]\n       setup.ts refresh-client <name> [gateway-url] [--directory path]')
    return
  }
  let directory = process.cwd()
  let docker = false
  const positional: string[] = []
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === '--directory') {
      const next = args[++index]
      if (!next) throw new Error('--directory requires a path')
      directory = resolve(next)
    } else if (argument === '--docker' && command === 'init') {
      docker = true
    } else if (argument.startsWith('--')) {
      throw new Error('Unknown setup option')
    } else {
      positional.push(argument)
    }
  }
  let launcher: string
  if (command === 'init' && positional.length <= 1) {
    launcher = createSetup(directory, positional[0] ?? 'local', docker)
  } else if (command === 'add-client' && positional.length >= 1 && positional.length <= 2) {
    launcher = addClient(directory, positional[0], positional[1])
  } else if (command === 'refresh-client' && positional.length >= 1 && positional.length <= 2) {
    launcher = refreshClient(directory, positional[0], positional[1])
  } else {
    throw new Error('Expected init [name], add-client <name> [gateway-url], or refresh-client <name> [gateway-url]')
  }
  console.log(`Client launcher: ${launcher}`)
  console.log('Keep the launcher private. Restart the gateway after changing client tokens.')
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`Setup failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    process.exitCode = 1
  }
}
