import { validateHeaderValue, type IncomingHttpHeaders } from 'http'
import type { Config } from './config.js'

export const DEFAULT_USER_AGENT = 'opencode/1.18.35'

const ALLOWED_HEADERS = new Set([
  'anthropic-version',
  'content-type',
  'content-encoding',
  'accept',
  'accept-encoding',
])
const SINGLE_VALUE_HEADERS = new Set(['anthropic-version', 'content-type'])

export function isValidUserAgent(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim()
    && /^opencode\/\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(value)
}

export function buildUpstreamHeaders(
  headers: IncomingHttpHeaders,
  upstream: Config['upstream'],
  contentLength: number,
): Record<string, string> {
  if (!isValidUserAgent(upstream.user_agent)) {
    throw new TypeError('Invalid upstream User-Agent')
  }
  if (typeof upstream.api_key !== 'string' || upstream.api_key.length === 0 || /[^\x21-\x7e]/.test(upstream.api_key)) {
    throw new TypeError('Invalid upstream API key')
  }
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    throw new TypeError('Invalid content length')
  }

  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'connection' || value === undefined) continue
    const values = typeof value === 'string' ? [value] : value
    if (!Array.isArray(values) || values.some(item => typeof item !== 'string')) {
      throw new TypeError('Invalid request header: connection')
    }
    if (values.some(item => item.split(',').some(field => ALLOWED_HEADERS.has(field.trim().toLowerCase())))) {
      throw new TypeError('Connection header cannot mark forwarded protocol headers as hop-by-hop')
    }
  }

  const collected = new Map<string, string[]>()
  for (const [originalName, value] of Object.entries(headers)) {
    const name = originalName.toLowerCase()
    if (!ALLOWED_HEADERS.has(name) || value === undefined) continue
    const values = typeof value === 'string' ? [value] : value
    if (!Array.isArray(values) || values.length === 0) {
      throw new TypeError(`Invalid request header: ${name}`)
    }
    for (const item of values) {
      if (typeof item !== 'string' || item.trim().length === 0) {
        throw new TypeError(`Invalid request header: ${name}`)
      }
      try {
        validateHeaderValue(name, item)
      } catch {
        throw new TypeError(`Invalid request header: ${name}`)
      }
    }
    const previous = collected.get(name) ?? []
    collected.set(name, [...previous, ...values])
  }

  const result: Record<string, string> = {}
  for (const [name, values] of collected) {
    if (SINGLE_VALUE_HEADERS.has(name) && values.length !== 1) {
      throw new TypeError(`Duplicate request header: ${name}`)
    }
    result[name] = values.join(', ')
  }

  const version = result['anthropic-version'] ?? '2023-06-01'
  const versionDate = new Date(`${version}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(version)
    || !Number.isFinite(versionDate.getTime())
    || versionDate.toISOString().slice(0, 10) !== version) {
    throw new TypeError('Invalid request header: anthropic-version')
  }

  // Identity, credentials, and framing are owned by the gateway.
  result['anthropic-version'] = version
  result['user-agent'] = upstream.user_agent
  result['x-api-key'] = upstream.api_key
  result['content-length'] = String(contentLength)
  return result
}
