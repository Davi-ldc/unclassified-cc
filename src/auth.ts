import type { IncomingMessage } from 'http'
import type { TokenEntry } from './config.js'

const CREDENTIAL_HEADERS = new Set(['x-api-key', 'authorization', 'proxy-authorization'])

export function createAuthenticator(tokens: TokenEntry[]): (req: IncomingMessage) => string | null {
  const tokenMap = new Map<string, string>()
  for (const entry of tokens) {
    if (tokenMap.has(entry.token)) throw new TypeError('Duplicate client token')
    tokenMap.set(entry.token, entry.name)
  }

  return (req) => {
    const values = new Map<string, string>()
    const pairs: Array<[string, string | string[] | undefined]> = []
    // rawHeaders retains duplicates that Node's parsed headers can discard.
    if (req.rawHeaders?.length) {
      if (req.rawHeaders.length % 2 !== 0) return null
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        pairs.push([req.rawHeaders[i], req.rawHeaders[i + 1]])
      }
    } else {
      pairs.push(...Object.entries(req.headers))
    }
    for (const [originalName, value] of pairs) {
      const name = originalName.toLowerCase()
      if (!CREDENTIAL_HEADERS.has(name)) continue
      if (typeof value !== 'string' || /[^\x20-\x7e\t]/.test(value) || values.has(name)) return null
      values.set(name, value)
    }

    let credential: string | undefined
    for (const [name, value] of values) {
      const candidate = name === 'x-api-key' ? value : /^Bearer[ \t]+([\x21-\x7e]+)$/i.exec(value)?.[1]
      if (!candidate || /[^\x21-\x7e]/.test(candidate)) return null
      if (credential !== undefined && candidate !== credential) return null
      credential = candidate
    }
    return credential === undefined ? null : tokenMap.get(credential) ?? null
  }
}
