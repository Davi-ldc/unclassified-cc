import { applyEdits, modify } from 'jsonc-parser'

export const OPUS_FAST_MODEL = 'claude-opus-5-5'
export const OPUS_FAST_BETA = 'fast-mode-2026-02-01'

// The caller validates the JSON first. Range edits leave signed history byte-for-byte intact.
export function pinOpusFast(text: string, pathname: string): string {
  const request = JSON.parse(text)
  const set = (path: string[], value: unknown) => {
    text = applyEdits(text, modify(text, path, value, {}))
  }
  if (request.model !== OPUS_FAST_MODEL) set(['model'], OPUS_FAST_MODEL)
  const speed = pathname === '/v1/messages' ? 'fast' : undefined
  if (request.speed !== speed) set(['speed'], speed)
  // A server-side fallback could silently run a different model.
  for (const field of ['fallbacks', 'temperature', 'top_p', 'top_k']) {
    if (Object.hasOwn(request, field)) set([field], undefined)
  }
  if (request.thinking?.type !== 'adaptive') set(['thinking'], { type: 'adaptive' })
  else if (Object.hasOwn(request.thinking, 'budget_tokens')) set(['thinking', 'budget_tokens'], undefined)
  return text
}
