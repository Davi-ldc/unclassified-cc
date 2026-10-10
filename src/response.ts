import { applyEdits, parseTree, type Edit, type Node as JsonNode, type ParseError } from 'jsonc-parser'
import { Transform, type TransformCallback } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import type { WireCodec } from './wire-profile.js'

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_SELECTOR_BYTES = 4 * 1024 * 1024
const MAX_BLOCKS = 1024
const MAX_DEPTH = 128
const MAX_INPUT_KEY_LENGTH = 256

type Domain = 'agent' | 'skill' | 'tool'

function property(node: JsonNode | undefined, name: string): JsonNode | undefined {
  if (node?.type !== 'object') return undefined
  const entries = node.children ?? []
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index].children?.[0]?.value === name) return entries[index].children?.[1]
  }
  return undefined
}

function tree(text: string): JsonNode | undefined {
  const errors: ParseError[] = []
  const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false })
  return errors.length ? undefined : root
}

function replaceString(node: JsonNode | undefined, value: string, edits: Edit[]) {
  if (node?.type === 'string' && node.value !== value) {
    edits.push({ offset: node.offset, length: node.length, content: JSON.stringify(value) })
  }
}

function restoreSelector(node: JsonNode | undefined, domain: Domain, codec: WireCodec, edits: Edit[]) {
  if (node?.type === 'string') replaceString(node, codec.decodeSelector(domain, node.value), edits)
}

function restoreInput(input: JsonNode | undefined, nativeTool: string, codec: WireCodec, edits: Edit[]) {
  if (!codec.needsInputTranslation(nativeTool)) return
  let fields: Map<string, JsonNode | undefined> | undefined
  if (codec.profileId === 'neutral-v2' && input?.type === 'object') {
    fields = new Map()
    for (const entry of input.children ?? []) {
      const key = entry.children?.[0]
      if (key?.type !== 'string') continue
      if (key.length > MAX_INPUT_KEY_LENGTH) throw new Error('Root input key exceeds the length limit')
      const nativeKey = codec.decodeInputKey(nativeTool, key.value)
      if (fields.has(nativeKey)) throw new Error(`Duplicate decoded root input key: ${nativeKey}`)
      fields.set(nativeKey, entry.children?.[1])
      replaceString(key, nativeKey, edits)
    }
  }
  const field = (key: string) => fields ? fields.get(key) : property(input, key)
  if (nativeTool === 'Agent') restoreSelector(field('subagent_type'), 'agent', codec, edits)
  if (nativeTool === 'Skill') restoreSelector(field('skill'), 'skill', codec, edits)
  if (nativeTool === 'ExitPlanMode') {
    const prompts = field('allowedPrompts')
    if (prompts?.type === 'array') {
      for (const prompt of prompts.children ?? []) restoreSelector(property(prompt, 'tool'), 'tool', codec, edits)
    }
  }
}

function restoreTool(block: JsonNode | undefined, codec: WireCodec, edits: Edit[]): string | undefined {
  if (property(block, 'type')?.value !== 'tool_use') return undefined
  const name = property(block, 'name')
  if (name?.type !== 'string') return undefined
  const nativeTool = codec.decodeTool(name.value)
  replaceString(name, nativeTool, edits)
  restoreInput(property(block, 'input'), nativeTool, codec, edits)
  return nativeTool
}

export function restoreJsonResponse(body: Buffer, codec: WireCodec): Buffer {
  if (!codec.active) return body
  const text = new StringDecoder('utf8').end(body)
  const root = tree(text)
  if (!root || root.type !== 'object') return body
  const content = property(root, 'content')
  if (content?.type !== 'array') return body
  const edits: Edit[] = []
  for (const block of content.children ?? []) restoreTool(block, codec, edits)
  if (!edits.length) return body
  if (!Buffer.from(text).equals(body)) throw new Error('Tool response must be valid UTF-8')
  return Buffer.from(applyEdits(text, edits))
}

type Frame = {
  kind: 'object' | 'array'
  phase: 'first' | 'key' | 'colon' | 'value' | 'next'
  context: 'root' | 'prompts' | 'prompt' | 'other'
  key?: string
}
type StringToken = {
  kind: 'string'
  key: boolean
  domain?: Domain
  rootKey?: boolean
  length: number
  raw?: string
  escaped: boolean
  unicode: number
}
type NumberState = 'minus' | 'zero' | 'integer' | 'dot' | 'fraction' | 'e' | 'sign' | 'exponent'
type Token = StringToken | { kind: 'literal'; expected: string; position: number } | { kind: 'number'; state: NumberState }

function whitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n'
}

function digit(char: string): boolean { return char >= '0' && char <= '9' }
function hex(char: string): boolean { return digit(char) || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F') }

// Selector strings and v2 root keys are retained. Literal values stream as received.
class InputDecoder {
  private readonly frames: Frame[] = []
  private readonly rootKeys = new Set<string>()
  private rootKeyBytes = 0
  private token?: Token
  private started = false
  private complete = false
  private selectorParts: string[] = []
  private selectorBytes = 0

  constructor(
    private readonly nativeTool: string,
    private readonly codec: WireCodec,
    private readonly selectorLimit: number,
    private readonly reserve: (bytes: number) => void,
  ) {}

  private invalid(): never { throw new Error('Malformed selector tool input JSON') }

  private doneValue() {
    const parent = this.frames.at(-1)
    if (parent) parent.phase = 'next'
    else {
      this.complete = true
      this.reserve(-this.rootKeyBytes)
      this.rootKeyBytes = 0
      this.rootKeys.clear()
    }
  }

  private domain(): Domain | undefined {
    const frame = this.frames.at(-1)
    if (frame?.kind !== 'object') return undefined
    if (frame.context === 'root') {
      if (this.nativeTool === 'Agent' && frame.key === 'subagent_type') return 'agent'
      if (this.nativeTool === 'Skill' && frame.key === 'skill') return 'skill'
    }
    if (this.nativeTool === 'ExitPlanMode' && frame.context === 'prompt' && frame.key === 'tool') return 'tool'
    return undefined
  }

  private open(kind: Frame['kind']) {
    if (this.frames.length === MAX_DEPTH) throw new Error('Selector tool input exceeds the nesting limit')
    const parent = this.frames.at(-1)
    const context = !parent ? 'root'
      : this.nativeTool === 'ExitPlanMode' && parent.context === 'root' && parent.key === 'allowedPrompts' && kind === 'array' ? 'prompts'
        : parent.context === 'prompts' && kind === 'object' ? 'prompt' : 'other'
    this.frames.push({ kind, context, phase: 'first' })
  }

  private retain(text: string) {
    if (!text.length) return
    const bytes = Buffer.byteLength(text)
    if (this.selectorBytes + bytes > this.selectorLimit) throw new Error('Selector string exceeds the response buffer limit')
    this.reserve(bytes)
    this.selectorBytes += bytes
    this.selectorParts.push(text)
    // Bound allocation overhead when the upstream sends one character per event.
    if (this.selectorParts.length === 1024) this.selectorParts = [this.selectorParts.join('')]
  }

  private finishString(token: StringToken): string {
    const raw = this.selectorParts.join('')
    const value: string = JSON.parse(raw)
    const decoded = token.rootKey ? this.codec.decodeInputKey(this.nativeTool, value) : this.codec.decodeSelector(token.domain!, value)
    this.reserve(-this.selectorBytes)
    this.selectorBytes = 0
    this.selectorParts = []
    if (token.rootKey) {
      if (this.rootKeys.has(decoded)) throw new Error(`Duplicate decoded root input key: ${decoded}`)
      // Keep collision detection bounded, including empty keys and Set entry overhead.
      const bytes = Buffer.byteLength(decoded) + 64
      this.reserve(bytes)
      this.rootKeyBytes += bytes
      this.rootKeys.add(decoded)
      this.frames.at(-1)!.key = decoded
    }
    return decoded === value ? raw : JSON.stringify(decoded)
  }

  private number(char: string, token: Extract<Token, { kind: 'number' }>): boolean {
    const state = token.state
    if (digit(char)) {
      if (state === 'zero') this.invalid()
      token.state = state === 'minus' ? (char === '0' ? 'zero' : 'integer')
        : state === 'dot' || state === 'fraction' ? 'fraction'
          : state === 'e' || state === 'sign' || state === 'exponent' ? 'exponent' : 'integer'
      return true
    }
    if (char === '.' && (state === 'zero' || state === 'integer')) { token.state = 'dot'; return true }
    if ((char === 'e' || char === 'E') && (state === 'zero' || state === 'integer' || state === 'fraction')) { token.state = 'e'; return true }
    if ((char === '+' || char === '-') && state === 'e') { token.state = 'sign'; return true }
    if (state !== 'zero' && state !== 'integer' && state !== 'fraction' && state !== 'exponent') this.invalid()
    this.token = undefined
    this.doneValue()
    return false
  }

  feed(text: string): string {
    const output: string[] = []
    let start = 0
    let selectedStart = this.token?.kind === 'string' && (this.token.domain || this.token.rootKey) ? 0 : -1
    for (let index = 0; index < text.length; index++) {
      const char = text[index]
      const token = this.token
      if (token?.kind === 'string') {
        if (token.rootKey && ++token.length > MAX_INPUT_KEY_LENGTH) throw new Error('Root input key exceeds the length limit')
        if (token.key && token.raw !== undefined) {
          token.raw += char
          if (token.raw.length > MAX_INPUT_KEY_LENGTH) token.raw = undefined
        }
        if (token.unicode) {
          if (!hex(char)) this.invalid()
          token.unicode--
        } else if (token.escaped) {
          token.escaped = false
          if (char === 'u') token.unicode = 4
          else if (!'"\\/bfnrt'.includes(char)) this.invalid()
        } else if (char === '\\') {
          token.escaped = true
        } else if (char === '"') {
          if (token.domain || token.rootKey) {
            this.retain(text.slice(selectedStart, index + 1))
            output.push(this.finishString(token))
            selectedStart = -1
            start = index + 1
          }
          this.token = undefined
          if (token.key) {
            const frame = this.frames.at(-1)!
            if (!token.rootKey) frame.key = token.raw === undefined ? undefined : JSON.parse(token.raw)
            frame.phase = 'colon'
          } else this.doneValue()
        } else if (char.charCodeAt(0) < 0x20) this.invalid()
        continue
      }
      if (token?.kind === 'literal') {
        if (char !== token.expected[token.position++]) this.invalid()
        if (token.position === token.expected.length) { this.token = undefined; this.doneValue() }
        continue
      }
      if (token?.kind === 'number' && this.number(char, token)) continue
      if (whitespace(char)) continue
      if (this.complete) this.invalid()
      const frame = this.frames.at(-1)
      if (frame?.phase === 'colon') {
        if (char !== ':') this.invalid()
        frame.phase = 'value'
        continue
      }
      if (frame?.phase === 'next') {
        if (char === ',') { frame.phase = frame.kind === 'object' ? 'key' : 'value'; continue }
        if (char !== (frame.kind === 'object' ? '}' : ']')) this.invalid()
        this.frames.pop()
        this.doneValue()
        continue
      }
      if (frame?.phase === 'first' && char === (frame.kind === 'object' ? '}' : ']')) {
        this.frames.pop()
        this.doneValue()
        continue
      }
      if (frame?.kind === 'object' && (frame.phase === 'first' || frame.phase === 'key')) {
        if (char !== '"') this.invalid()
        const rootKey = this.codec.profileId === 'neutral-v2' && frame.context === 'root'
        this.token = { kind: 'string', key: true, rootKey, length: 1, raw: rootKey ? undefined : '"', escaped: false, unicode: 0 }
        if (rootKey) { output.push(text.slice(start, index)); selectedStart = index }
        continue
      }
      if (!this.started) {
        if (char !== '{') this.invalid()
        this.started = true
      }
      if (char === '{' || char === '[') { this.open(char === '{' ? 'object' : 'array'); continue }
      if (char === '"') {
        const domain = this.domain()
        this.token = { kind: 'string', key: false, domain, length: 1, escaped: false, unicode: 0 }
        if (domain) { output.push(text.slice(start, index)); selectedStart = index }
      } else if (char === 't' || char === 'f' || char === 'n') {
        this.token = { kind: 'literal', expected: char === 't' ? 'true' : char === 'f' ? 'false' : 'null', position: 1 }
      } else if (char === '-' || digit(char)) {
        this.token = { kind: 'number', state: char === '-' ? 'minus' : char === '0' ? 'zero' : 'integer' }
      } else this.invalid()
    }
    if (selectedStart !== -1) this.retain(text.slice(selectedStart))
    else output.push(text.slice(start))
    return output.join('')
  }

  finish() {
    if (this.token || this.frames.length || !this.complete) throw new Error('Truncated selector tool input JSON')
  }
}

type DataLine = { offset: number; length: number; rawOffset: number }
type Event = { text: string; data: string; lines: DataLine[]; name: string }

function parseEvent(text: string): Event {
  const lines: DataLine[] = []
  const values: string[] = []
  let dataLength = 0
  let name = ''
  let start = 0
  while (start < text.length) {
    const newline = text.indexOf('\n', start)
    const end = newline === -1 ? text.length : newline
    const contentEnd = text[end - 1] === '\r' ? end - 1 : end
    const line = text.slice(start, contentEnd)
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let valueStart = colon === -1 ? line.length : colon + 1
    if (line[valueStart] === ' ') valueStart++
    if (field === 'data') {
      const value = line.slice(valueStart)
      lines.push({ offset: dataLength, length: value.length, rawOffset: start + valueStart })
      values.push(value)
      dataLength += value.length + 1
    } else if (field === 'event') name = line.slice(valueStart)
    start = end + 1
  }
  return { text, data: values.join('\n'), lines, name }
}

function editEvent(event: Event, raw: Buffer, edits: Edit[]): Buffer {
  if (!edits.length) return raw
  if (!Buffer.from(event.text).equals(raw)) throw new Error('Tool event must be valid UTF-8')
  const mapped = edits.map(edit => {
    const line = event.lines.find(candidate => edit.offset >= candidate.offset && edit.offset + edit.length <= candidate.offset + candidate.length)
    if (!line) throw new Error('Invalid SSE JSON string range')
    return { ...edit, offset: line.rawOffset + edit.offset - line.offset }
  })
  return Buffer.from(applyEdits(event.text, mapped))
}

type Block = { nativeTool: string; decoder?: InputDecoder }

class ResponseTransform extends Transform {
  private readonly decoder = new StringDecoder('utf8')
  private readonly blocks = new Map<number, Block>()
  private pending = Buffer.alloc(0)
  private pendingBytes = 0
  private lineBytes = 0
  private previousByte = -1
  private retainedBytes = 0

  constructor(private readonly codec: WireCodec, private readonly mode: 'sse' | 'json', private readonly maxBytes: number) {
    super()
  }

  private append(chunk: Buffer) {
    const size = this.pendingBytes + chunk.length
    if (size > this.maxBytes) throw new Error('Response exceeds the JSON or SSE event size limit')
    if (size > this.pending.length) {
      const capacity = Math.min(this.maxBytes, Math.max(size, this.pending.length * 2, 4096))
      const next = Buffer.allocUnsafe(capacity)
      this.pending.copy(next, 0, 0, this.pendingBytes)
      this.pending = next
    }
    chunk.copy(this.pending, this.pendingBytes)
    this.pendingBytes = size
  }

  private reserve = (bytes: number) => {
    if (this.retainedBytes + bytes > this.maxBytes) throw new Error('Selector inputs exceed the aggregate response buffer limit')
    this.retainedBytes += bytes
  }

  private event(raw: Buffer): Buffer {
    const event = parseEvent(this.decoder.write(raw))
    if (!event.data) return raw
    const known = ['content_block_start', 'content_block_delta', 'content_block_stop', 'message_stop']
    if (event.name && !known.includes(event.name)) return raw
    const root = tree(event.data)
    if (!root) {
      if (known.includes(event.name)) throw new Error('Malformed tool SSE event JSON')
      return raw
    }
    const type = property(root, 'type')?.value
    const index = property(root, 'index')?.value
    const edits: Edit[] = []
    if (type === 'content_block_start') {
      if (this.blocks.has(index)) throw new Error('Duplicate open selector tool index')
      const nativeTool = restoreTool(property(root, 'content_block'), this.codec, edits)
      if (nativeTool && this.codec.needsInputTranslation(nativeTool)) {
        if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid selector tool block index')
        if (this.blocks.size === MAX_BLOCKS) throw new Error('Too many open selector tool blocks')
        this.blocks.set(index, { nativeTool })
      }
    } else if (type === 'content_block_delta') {
      const block = this.blocks.get(index)
      const delta = property(root, 'delta')
      if (block && property(delta, 'type')?.value === 'input_json_delta') {
        const partial = property(delta, 'partial_json')
        if (partial?.type !== 'string') throw new Error('Invalid selector tool input delta')
        block.decoder ??= new InputDecoder(block.nativeTool, this.codec, Math.min(MAX_SELECTOR_BYTES, this.maxBytes), this.reserve)
        replaceString(partial, block.decoder.feed(partial.value), edits)
      }
    } else if (type === 'content_block_stop') {
      this.blocks.get(index)?.decoder?.finish()
      this.blocks.delete(index)
    } else if (type === 'message_stop' && this.blocks.size) {
      throw new Error('Message ended with open selector tool blocks')
    }
    return editEvent(event, raw, edits)
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    try {
      if (!this.codec.active) { callback(null, chunk); return }
      if (this.mode === 'json') { this.append(chunk); callback(); return }
      let start = 0
      for (let index = 0; index < chunk.length; index++) {
        const byte = chunk[index]
        if (byte === 10) {
          const blank = this.lineBytes === 0 || (this.lineBytes === 1 && this.previousByte === 13)
          this.lineBytes = 0
          if (blank) {
            this.append(chunk.subarray(start, index + 1))
            const raw = Buffer.from(this.pending.subarray(0, this.pendingBytes))
            this.pendingBytes = 0
            start = index + 1
            this.push(this.event(raw))
          }
        } else this.lineBytes++
        this.previousByte = byte
      }
      this.append(chunk.subarray(start))
      callback()
    } catch (error) { callback(error as Error) }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.pending = Buffer.alloc(0)
    this.pendingBytes = 0
    this.blocks.clear()
    callback(error)
  }

  override _flush(callback: TransformCallback) {
    try {
      if (this.codec.active) {
        if (this.mode === 'json') this.push(restoreJsonResponse(this.pending.subarray(0, this.pendingBytes), this.codec))
        else {
          if (this.pendingBytes) {
            const raw = Buffer.from(this.pending.subarray(0, this.pendingBytes))
            // An unterminated event cannot safely complete a selector block.
            if (this.blocks.size) throw new Error('Truncated SSE event with open selector tool blocks')
            this.push(this.event(raw))
          }
          this.decoder.end()
          if (this.blocks.size) throw new Error('Truncated response with open selector tool blocks')
        }
      }
      callback()
    } catch (error) { callback(error as Error) }
  }
}

export function createResponseTransform(codec: WireCodec, mode: 'sse' | 'json', maxBytes = MAX_RESPONSE_BYTES): Transform {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('Response byte limit must be a positive safe integer')
  return new ResponseTransform(codec, mode, maxBytes)
}
