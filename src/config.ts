import { readFileSync } from 'fs'
import { isIP } from 'net'
import { resolve } from 'path'
import { parse } from 'yaml'
import { DEFAULT_USER_AGENT, isValidUserAgent } from './headers.js'

export type TokenEntry = {
  name: string
  token: string
}

export type Config = {
  server: {
    host: string
    port: number
    tls?: {
      cert: string
      key: string
    }
    max_body_bytes: number
    request_timeout_ms: number
    upstream_timeout_ms: number
  }
  upstream: {
    url: string
    api_key: string
    fallback_api_keys?: string[]
    user_agent: string
  }
  auth: {
    tokens: TokenEntry[]
  }
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error'
    audit: boolean
  }
}

function object(value: unknown, field: string, allowed: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`config: ${field} must be an object`)
  }
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error(`config: ${field} contains unsupported fields`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0
    || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`config: ${field} must be a nonempty string without control characters`)
  }
  return value
}

function credential(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[^\x21-\x7e]/.test(value)) {
    throw new Error(`config: ${field} must be a nonempty ASCII credential without whitespace`)
  }
  return value
}

function integer(value: unknown, field: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`config: ${field} must be an integer between ${min} and ${max}`)
  }
  return value
}

function upstreamOrigin(value: unknown): string {
  const input = text(value, 'upstream.url')
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error('config: upstream.url must be an absolute HTTP(S) origin')
  }
  if (/[\\?#]/.test(input) || url.username || url.password || url.pathname !== '/') {
    throw new Error('config: upstream.url must not include credentials, a path, query, or fragment')
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]'
    || (isIP(url.hostname) === 4 && url.hostname.startsWith('127.'))
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('config: upstream.url requires HTTPS except for loopback HTTP')
  }
  return url.origin
}

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): Config {
  const root = object(raw, 'root', ['server', 'upstream', 'auth', 'logging'])
  const server = object(root.server === undefined ? {} : root.server, 'server', [
    'host', 'port', 'tls', 'max_body_bytes', 'request_timeout_ms', 'upstream_timeout_ms',
  ])
  const upstream = object(root.upstream === undefined ? {} : root.upstream, 'upstream', ['url', 'user_agent'])
  const auth = object(root.auth, 'auth', ['tokens'])
  const logging = object(root.logging === undefined ? {} : root.logging, 'logging', ['level', 'audit'])
  const apiKey = credential(env.CC_GATEWAY_UPSTREAM_API_KEY, 'CC_GATEWAY_UPSTREAM_API_KEY')
  let fallbackKeys: unknown = []
  const fallbackSource = env.CC_GATEWAY_FALLBACK_API_KEYS
  // An empty value means "no additional keys", which an env file may legitimately contain.
  if (fallbackSource !== undefined && fallbackSource.trim() !== '') {
    try {
      fallbackKeys = JSON.parse(fallbackSource)
    } catch {
      throw new Error('config: CC_GATEWAY_FALLBACK_API_KEYS must be a JSON array')
    }
  }
  if (!Array.isArray(fallbackKeys) || fallbackKeys.length > 7) {
    throw new Error('config: CC_GATEWAY_FALLBACK_API_KEYS must be an array of at most 7 credentials')
  }
  const upstreamKeys = new Set([apiKey])
  const fallbackApiKeys = fallbackKeys.map(value => {
    const key = credential(value, 'CC_GATEWAY_FALLBACK_API_KEYS entry')
    if (upstreamKeys.has(key)) throw new Error('config: upstream API keys must be unique')
    upstreamKeys.add(key)
    return key
  })

  if (!Array.isArray(auth.tokens) || auth.tokens.length === 0) {
    throw new Error('config: auth.tokens must contain at least one client')
  }
  const names = new Set<string>()
  const credentials = new Set<string>()
  const tokens = auth.tokens.map(value => {
    const entry = object(value, 'auth.tokens entry', ['name', 'token'])
    const name = text(entry.name, 'auth.tokens.name')
    const token = credential(entry.token, 'auth.tokens.token')
    if (names.has(name) || credentials.has(token)) {
      throw new Error('config: client names and tokens must be unique')
    }
    if (upstreamKeys.has(token)) {
      throw new Error('config: client tokens must differ from every upstream API key')
    }
    names.add(name)
    credentials.add(token)
    return { name, token }
  })

  const host = text(server.host === undefined ? '127.0.0.1' : server.host, 'server.host')
  if (!isIP(host) && host !== 'localhost') {
    throw new Error('config: server.host must be an IP address or localhost')
  }
  let tls: Config['server']['tls']
  if (server.tls !== undefined) {
    const value = object(server.tls, 'server.tls', ['cert', 'key'])
    tls = { cert: text(value.cert, 'server.tls.cert'), key: text(value.key, 'server.tls.key') }
  }
  const userAgent = upstream.user_agent === undefined ? DEFAULT_USER_AGENT : upstream.user_agent
  if (!isValidUserAgent(userAgent)) {
    throw new Error('config: upstream.user_agent must be an opencode/version identity')
  }
  const level = logging.level === undefined ? 'info' : logging.level
  if (typeof level !== 'string' || !['debug', 'info', 'warn', 'error'].includes(level)) {
    throw new Error('config: logging.level must be debug, info, warn, or error')
  }
  const audit = logging.audit === undefined ? false : logging.audit
  if (typeof audit !== 'boolean') {
    throw new Error('config: logging.audit must be a boolean')
  }

  return {
    server: {
      host,
      port: integer(server.port, 'server.port', 8443, 0, 65535),
      ...(tls && { tls }),
      max_body_bytes: integer(server.max_body_bytes, 'server.max_body_bytes', 32 * 1024 * 1024, 1, 2 ** 31 - 1),
      request_timeout_ms: integer(server.request_timeout_ms, 'server.request_timeout_ms', 120000, 1, 2 ** 31 - 1),
      upstream_timeout_ms: integer(server.upstream_timeout_ms, 'server.upstream_timeout_ms', 600000, 1, 2 ** 31 - 1),
    },
    upstream: {
      url: upstreamOrigin(upstream.url === undefined ? 'https://api.anthropic.com' : upstream.url),
      api_key: apiKey,
      fallback_api_keys: fallbackApiKeys,
      user_agent: userAgent,
    },
    auth: { tokens },
    logging: { level: level as Config['logging']['level'], audit },
  }
}

export function loadConfig(configPath?: string, env: NodeJS.ProcessEnv = process.env): Config {
  const filePath = configPath || resolve(process.cwd(), 'config.yaml')
  let source: string
  try {
    source = readFileSync(filePath, 'utf-8')
  } catch {
    throw new Error('config: unable to read configuration file')
  }
  let raw: unknown
  try {
    raw = parse(source)
  } catch {
    throw new Error('config: invalid YAML')
  }
  return parseConfig(raw, env)
}
