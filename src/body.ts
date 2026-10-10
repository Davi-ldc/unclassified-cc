import { applyEdits, getNodeValue, modify, parseTree, type Edit, type Node as JsonNode, type ParseError } from 'jsonc-parser'
import { rewriteGeneratedContext } from './context.js'
import { createWireCodec, type WireCodec } from './wire-profile.js'
import { curateToolSchema, TOOL_DESCRIPTIONS } from './tool-descriptions.js'
import { promisify } from 'util'
import { brotliCompress, brotliDecompress, deflate, gzip, gunzip, inflate, zstdCompress, zstdDecompress } from 'zlib'

export const CONTEXT_ATTRIBUTION = "Claude Code attached this context automatically; it isn't part of the user's message."
export const PRIVATE_CONTEXT_ATTRIBUTION = "CC  attached this context automatically; it isn't part of the user's message."
const CONTEXT_START = "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n"
const codecs = {
  gzip: [promisify(gunzip), promisify(gzip)],
  deflate: [promisify(inflate), promisify(deflate)],
  br: [promisify(brotliDecompress), promisify(brotliCompress)],
  zstd: [promisify(zstdDecompress), promisify(zstdCompress)],
} as const

export class BodyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function property(node: JsonNode | undefined, name: string): JsonNode | undefined {
  return node?.type === 'object'
    ? node.children?.find(entry => entry.children?.[0]?.value === name)?.children?.[1]
    : undefined
}

function rewriteJson(text: string): string {
  const errors: ParseError[] = []
  const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false })
  if (!root || root.type !== 'object' || errors.length) return text
  const edits: Edit[] = []
  const metadataEntries = root.children?.filter(entry => entry.children?.[0]?.value === 'metadata') ?? []
  if (metadataEntries.length > 1) throw new BodyError(400, 'Duplicate metadata fields')
  const metadata = property(root, 'metadata')
  if (property(metadata, 'user_id')) {
    const ids = metadata!.children!.filter(entry => entry.children?.[0]?.value === 'user_id')
    if (ids.length > 1) throw new BodyError(400, 'Duplicate user identifier fields')
    const path = metadata!.children!.length === 1 ? ['metadata'] : ['metadata', 'user_id']
    edits.push(...modify(text, path, undefined, {}))
  }

  for (const message of property(root, 'messages')?.children ?? []) {
    const role = property(message, 'role')?.value
    if (role !== 'user' && role !== 'system') continue
    const content = property(message, 'content')
    const texts = content?.type === 'string' ? [content]
      : content?.type === 'array'
        ? content.children?.filter(block => property(block, 'type')?.value === 'text').map(block => property(block, 'text')) ?? []
        : []
    for (const node of texts) {
      if (node?.type !== 'string') continue
      const value: string = node.value
      if (!value.startsWith(CONTEXT_START) || !value.trimEnd().endsWith('</system-reminder>')) continue
      const replacement = value.replaceAll(`\n${CONTEXT_ATTRIBUTION}`, `\n${PRIVATE_CONTEXT_ATTRIBUTION}`)
      if (replacement !== value) {
        edits.push({ offset: node.offset, length: node.length, content: JSON.stringify(replacement) })
      }
    }
  }
  // Range edits preserve unrelated strings, signatures, whitespace, and numeric literals.
  return edits.length ? applyEdits(text, edits) : text
}

function uniqueFields(node: JsonNode | undefined): void {
  if (node?.type !== 'object') return
  const names = new Set<string>()
  for (const entry of node.children ?? []) {
    const name: string = entry.children![0].value
    if (names.has(name)) throw new BodyError(400, 'Duplicate request structure fields')
    names.add(name)
  }
}

function replaceString(node: JsonNode | undefined, rewrite: (value: string) => string, edits: Edit[]): void {
  if (node?.type !== 'string') return
  const value = rewrite(node.value)
  if (value !== node.value) edits.push({ offset: node.offset, length: node.length, content: JSON.stringify(value) })
}

function schemaEdits(schema: JsonNode | undefined, nativeTool: string, codec: WireCodec, edits: Edit[], path: string[] = []): void {
  if (schema?.type !== 'object') return
  uniqueFields(schema)
  for (const key of ['description', 'title', '$comment']) replaceString(property(schema, key), value => codec.rewriteInstruction(value), edits)
  const selector = nativeTool === 'Agent' && path.join('.') === 'subagent_type' ? 'agent'
    : nativeTool === 'Skill' && path.join('.') === 'skill' ? 'skill'
      : nativeTool === 'ExitPlanMode' && path.join('.') === 'allowedPrompts.[].tool' ? 'tool' : undefined
  if (selector) {
    for (const entry of property(schema, 'enum')?.children ?? []) replaceString(entry, value => codec.encodeSelector(selector, value), edits)
    replaceString(property(schema, 'const'), value => codec.encodeSelector(selector, value), edits)
  }
  for (const keyword of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) {
    const map = property(schema, keyword)
    uniqueFields(map)
    for (const entry of map?.children ?? []) {
      const [name, value] = entry.children ?? []
      if (name && value) schemaEdits(value, nativeTool, codec, edits, keyword === 'properties' ? [...path, name.value] : [...path, `@${keyword}`, name.value])
    }
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    for (const child of property(schema, keyword)?.children ?? []) schemaEdits(child, nativeTool, codec, edits, keyword === 'prefixItems' ? [...path, '[]'] : path)
  }
  for (const keyword of ['items', 'additionalProperties', 'unevaluatedProperties', 'contains', 'not', 'if', 'then', 'else', 'propertyNames']) {
    const child = property(schema, keyword)
    schemaEdits(child, nativeTool, codec, edits, keyword === 'items' ? [...path, '[]'] : [...path, `@${keyword}`])
  }
}

function uniqueTreeFields(node: JsonNode): void {
  uniqueFields(node)
  for (const child of node.children ?? []) uniqueTreeFields(child)
}

function inputEdits(input: JsonNode | undefined, nativeTool: string, codec: WireCodec, edits: Edit[]): void {
  if (input?.type !== 'object' || !codec.needsInputTranslation(nativeTool)) return
  uniqueFields(input)
  if (nativeTool === 'ExitPlanMode') {
    for (const prompt of property(input, 'allowedPrompts')?.children ?? []) uniqueFields(prompt)
  }
  const translated = codec.translateInput(nativeTool, getNodeValue(input), 'encode')
  // Only root keys and selector strings change; argument values retain their original bytes.
  for (const entry of input.children ?? []) {
    const [key, value] = entry.children!
    const encodedKey = codec.encodeInputKey(nativeTool, key.value)
    replaceString(key, () => encodedKey, edits)
    if (nativeTool === 'Agent' && key.value === 'subagent_type'
      || nativeTool === 'Skill' && key.value === 'skill') {
      const replacement = (translated as Record<string, unknown>)[encodedKey]
      if (typeof replacement === 'string') replaceString(value, () => replacement, edits)
    } else if (nativeTool === 'ExitPlanMode' && key.value === 'allowedPrompts' && value.type === 'array') {
      for (const prompt of value.children ?? []) {
        replaceString(property(prompt, 'tool'), name => codec.encodeSelector('tool', name), edits)
      }
    }
  }
}

function referenceEdits(block: JsonNode, codec: WireCodec, edits: Edit[]): void {
  uniqueFields(block)
  const type = property(block, 'type')?.value
  if (type === 'tool_reference') {
    replaceString(property(block, 'tool_name'), value => codec.encodeTool(value), edits)
  } else if (type === 'tool_search_tool_search_result' || type === 'tool_search_tool_result') {
    for (const key of ['content', 'tool_references']) {
      const content = property(block, key)
      if (content?.type === 'array') for (const child of content.children ?? []) referenceEdits(child, codec, edits)
      else if (content?.type === 'object') referenceEdits(content, codec, edits)
    }
  }
}

function removeArrayItems(array: JsonNode, removed: Set<JsonNode>, edits: Edit[]): void {
  const children = array.children ?? []
  for (let index = 0; index < children.length; index++) {
    if (!removed.has(children[index])) continue
    const first = index
    while (index + 1 < children.length && removed.has(children[index + 1])) index++
    const start = first === 0 ? children[first].offset : children[first - 1].offset + children[first - 1].length
    const end = index + 1 === children.length ? children[index].offset + children[index].length
      : first === 0 ? children[index + 1].offset : children[index].offset + children[index].length
    edits.push({ offset: start, length: end - start, content: '' })
  }
}

function contextEdits(content: JsonNode | undefined, role: 'system' | 'user', codec: WireCodec, edits: Edit[]): boolean {
  const texts = content?.type === 'string' ? [content]
    : content?.type === 'array' ? content.children ?? [] : []
  const removed = new Set<JsonNode>()
  const local: Edit[] = []
  for (const block of texts) {
    if (block.type === 'object') uniqueFields(block)
    const text = content?.type === 'string' ? block : property(block, 'type')?.value === 'text' ? property(block, 'text') : undefined
    if (text?.type !== 'string') continue
    const result = rewriteGeneratedContext(text.value, role, codec)
    if (result === undefined) removed.add(block)
    else replaceString(text, () => result, local)
  }
  if (texts.length > 0 && removed.size === texts.length) return true
  if (content?.type === 'array') removeArrayItems(content, removed, local)
  edits.push(...local)
  return false
}

function rewriteNeutralJson(text: string, profileId: 'neutral-v1' | 'neutral-v2'): { text: string; codec: WireCodec } {
  const errors: ParseError[] = []
  const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false })
  if (!root || root.type !== 'object' || errors.length) throw new BodyError(400, 'Request body must be a JSON object')
  uniqueFields(root)
  const metadata = property(root, 'metadata')
  uniqueFields(metadata)
  const tools = property(root, 'tools')
  if (tools?.type === 'array') for (const tool of tools.children ?? []) uniqueFields(tool)
  const messages = property(root, 'messages')
  if (messages?.type === 'array') {
    for (const message of messages.children ?? []) {
      uniqueFields(message)
      const content = property(message, 'content')
      if (content?.type === 'array') for (const block of content.children ?? []) uniqueFields(block)
    }
  }
  uniqueFields(property(root, 'tool_choice'))
  const codec = createWireCodec(JSON.parse(text), profileId)
  const edits: Edit[] = []
  const removedFields = new Set<JsonNode>()
  const field = (object: JsonNode, name: string) => object.children!.find(entry => entry.children![0].value === name)!
  if (property(metadata, 'user_id')) {
    if (metadata!.children!.length === 1) removedFields.add(field(root, 'metadata'))
    else removeArrayItems(metadata!, new Set([field(metadata!, 'user_id')]), edits)
  }
  const system = property(root, 'system')
  if (contextEdits(system, 'system', codec, edits)) removedFields.add(field(root, 'system'))
  if (tools?.type === 'array') for (const tool of tools.children ?? []) {
    const name = property(tool, 'name')
    const type = property(tool, 'type')?.value
    if (name?.type !== 'string' || (type !== undefined && type !== 'custom') || codec.encodeTool(name.value) === name.value) continue
    replaceString(name, value => codec.encodeTool(value), edits)
    if (profileId === 'neutral-v2' && Object.hasOwn(TOOL_DESCRIPTIONS, name.value)) {
      const description = property(tool, 'description')
      const content = JSON.stringify(TOOL_DESCRIPTIONS[name.value as keyof typeof TOOL_DESCRIPTIONS])
      edits.push(description
        ? { offset: description.offset, length: description.length, content }
        : { offset: tool.offset + 1, length: 0, content: `"description":${content},` })
      const schema = property(tool, 'input_schema')
      if (schema) {
        uniqueTreeFields(schema)
        const encoded = codec.encodeToolSchema(name.value, getNodeValue(schema))
        const curated = curateToolSchema(name.value, encoded, codec)
        edits.push({ offset: schema.offset, length: schema.length, content: JSON.stringify(curated) })
      }
    } else {
      replaceString(property(tool, 'description'), value => codec.rewriteInstruction(value), edits)
      schemaEdits(property(tool, 'input_schema'), name.value, codec, edits)
    }
  }
  const choice = property(root, 'tool_choice')
  if (property(choice, 'type')?.value === 'tool') replaceString(property(choice, 'name'), value => codec.encodeTool(value), edits)
  const removedMessages = new Set<JsonNode>()
  if (messages?.type === 'array') for (const message of messages.children ?? []) {
    const role = property(message, 'role')?.value
    const content = property(message, 'content')
    if ((role === 'user' || role === 'system') && contextEdits(content, role, codec, edits)) {
      removedMessages.add(message)
      continue
    }
    if (content?.type !== 'array') continue
    for (const block of content.children ?? []) {
      const type = property(block, 'type')?.value
      if (role === 'assistant' && type === 'tool_use') {
        const name = property(block, 'name')
        if (name?.type !== 'string') continue
        replaceString(name, value => codec.encodeTool(value), edits)
        inputEdits(property(block, 'input'), name.value, codec, edits)
      } else if (role === 'user' && type === 'tool_result') {
        const result = property(block, 'content')
        if (result?.type === 'array') for (const child of result.children ?? []) referenceEdits(child, codec, edits)
        else if (result?.type === 'object') referenceEdits(result, codec, edits)
      } else if (role === 'user' && type === 'tool_search_tool_result') {
        referenceEdits(block, codec, edits)
      }
    }
  }
  if (messages?.type === 'array') removeArrayItems(messages, removedMessages, edits)
  removeArrayItems(root, removedFields, edits)
  return { text: edits.length ? applyEdits(text, edits) : text, codec }
}

export async function rewriteRequestBody(body: Buffer, pathname: string, encoding: string | undefined, maxBytes: number): Promise<Buffer> {
  if (!body.length || (pathname !== '/v1/messages' && pathname !== '/v1/messages/count_tokens')) return body
  return transformBody(body, encoding, maxBytes, rewriteJson)
}

export async function prepareNeutralRequest(body: Buffer, pathname: string, encoding: string | undefined, maxBytes: number, profileId: 'neutral-v1' | 'neutral-v2' = 'neutral-v1'): Promise<{ body: Buffer; codec: WireCodec }> {
  if (pathname !== '/v1/messages' && pathname !== '/v1/messages/count_tokens') return { body, codec: createWireCodec({}, profileId) }
  let codec: WireCodec | undefined
  const output = await transformBody(body, encoding, maxBytes, text => {
    const result = rewriteNeutralJson(text, profileId)
    codec = result.codec
    if (Buffer.byteLength(result.text) > maxBytes) throw new BodyError(413, 'Rewritten request body is too large')
    return result.text
  })
  return { body: output, codec: codec! }
}

async function transformBody(body: Buffer, encoding: string | undefined, maxBytes: number, rewrite: (text: string) => string): Promise<Buffer> {
  const encodings = (encoding ?? 'identity').toLowerCase().split(',').map(value => value.trim()).filter(value => value !== 'identity')
  if (encodings.length > 4 || encodings.some(value => !Object.hasOwn(codecs, value))) {
    throw new BodyError(415, 'Unsupported request content encoding')
  }
  let decoded = body
  try {
    for (const name of [...encodings].reverse()) {
      decoded = await codecs[name as keyof typeof codecs][0](decoded, { maxOutputLength: maxBytes })
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new BodyError(413, 'Decoded request body is too large')
    }
    throw new BodyError(400, 'Invalid compressed request body')
  }
  if (decoded.length > maxBytes) throw new BodyError(413, 'Decoded request body is too large')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(decoded)
  } catch {
    throw new BodyError(400, 'Request body must be UTF-8')
  }
  const replacement = rewrite(text)
  if (replacement === text) return body
  let output: Buffer = Buffer.from(replacement)
  for (const name of encodings) output = await codecs[name as keyof typeof codecs][1](output)
  return output
}
