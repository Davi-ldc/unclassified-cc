export type KeyFailure = 'authentication' | 'billing' | 'rate_limit' | 'transient'

const COOLDOWN_MS: Record<KeyFailure, number> = {
  authentication: 60_000,
  billing: 60_000,
  rate_limit: 30_000,
  transient: 5_000,
}
export const MAX_COOLDOWN_MS = 300_000
// The API reports an exhausted balance as a 400 with this sentence; the CLI paraphrases it slightly.
const CREDIT_BALANCE_TOO_LOW = /\bcredit balance (?:is )?too low\b/i

function retryDelay(value: string | undefined, now: number): number {
  if (!value || value.length > 128) return 0
  const trimmed = value.trim()
  const delay = /^\d+(?:\.\d+)?$/.test(trimmed)
    ? Number(trimmed) * 1000
    : Date.parse(trimmed) - now
  return Number.isNaN(delay) ? 0 : Math.min(MAX_COOLDOWN_MS, Math.max(0, delay))
}

// A server owns one pool. Only indices and deadlines belong here, never credentials.
export class KeyPool {
  private readonly unavailableUntil: number[]

  constructor(count: number, private readonly now: () => number = Date.now) {
    if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error('Invalid upstream key count')
    this.unavailableUntil = Array(count).fill(0)
  }

  candidates(): number[] {
    const now = this.now()
    return this.unavailableUntil.flatMap((until, index) => until <= now ? [index] : [])
  }

  available(index: number): boolean {
    return this.unavailableUntil[index] <= this.now()
  }

  defer(index: number, reason: KeyFailure, retryAfter?: string) {
    if (this.unavailableUntil.length === 1) return
    const now = this.now()
    const delay = Math.max(COOLDOWN_MS[reason], retryDelay(retryAfter, now))
    this.unavailableUntil[index] = Math.max(this.unavailableUntil[index], now + delay)
  }

  retryAfter(): number {
    return Math.max(1, Math.ceil((Math.min(...this.unavailableUntil) - this.now()) / 1000))
  }
}

export function keyFailure(status: number, errorBody?: Buffer): KeyFailure | undefined {
  if (status === 429) return 'rate_limit'
  if ([500, 502, 503, 504].includes(status)) return 'transient'
  if ((status !== 400 && status !== 401) || !errorBody) return undefined
  try {
    const body = JSON.parse(errorBody.toString('utf8'))
    if (body?.type !== 'error') return undefined
    if (status === 401 && body.error?.type === 'authentication_error') return 'authentication'
    if (status === 400 && body.error?.type === 'invalid_request_error'
      && typeof body.error.message === 'string'
      && CREDIT_BALANCE_TOO_LOW.test(body.error.message)) {
      return 'billing'
    }
  } catch {
    // An unrecognized error is returned unchanged.
  }
  return undefined
}
