import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { StringDecoder } from 'node:string_decoder'
import { test, type TestContext } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { gunzipSync, gzipSync } from 'node:zlib'
import { createWireCodec } from '../src/wire-profile.js'
import { PARAMETER_ALIASES } from '../src/parameter-profile.js'
import {
  bodyOf, deferred, gateway, mockServer, openCall, origin, TEST_OPTIONS,
  type CallOptions,
} from './support.js'

const v2 = { path: '/agent-v2/v1/messages', headers: { 'content-type': 'application/json' } }
const literal = 'Read Write Agent Skill path text skill file_path content prompt stay literal: café.'
const nestedLiteral = { path: '/tmp/literal', text: literal, skill: 'claude-api', file_path: 'untouched', content: 'untouched' }
const cache = { type: 'ephemeral', ttl: '1h' }
const aliases = {
  Agent: 'delegate', AskUserQuestion: 'ask_user', Bash: 'shell', CronCreate: 'schedule_job',
  CronDelete: 'cancel_job', CronList: 'list_jobs', Edit: 'edit_file', EnterPlanMode: 'begin_planning',
  EnterWorktree: 'enter_workspace', ExitPlanMode: 'finish_planning', ExitWorktree: 'leave_workspace',
  ListAgents: 'list_agents', NotebookEdit: 'edit_notebook', Read: 'read_file', ReportFindings: 'report_findings',
  ScheduleWakeup: 'schedule_wakeup', SendMessage: 'send_message', Skill: 'load_skill', TaskStop: 'stop_task',
  WebFetch: 'fetch_url', WebSearch: 'search_web', Workflow: 'run_workflow', Write: 'write_file',
}
const keys: Record<string, Record<string, string>> = {
  Read: { file_path: 'path', offset: 'start', limit: 'count', pages: 'page_range', allow_large: 'allow_oversize' },
  Write: { file_path: 'path', content: 'text' },
  Edit: { file_path: 'path', old_string: 'search', new_string: 'replacement', replace_all: 'all_matches' },
  Bash: { command: 'script', timeout: 'timeout_ms', description: 'label', run_in_background: 'background', dangerouslyDisableSandbox: 'bypass_sandbox' },
  Agent: { description: 'label', prompt: 'task', subagent_type: 'agent_type' },
  Skill: { skill: 'name', args: 'arguments' },
  ExitPlanMode: { allowedPrompts: 'permissions' },
}

type Shape = Record<string, any>
const cases: Array<{ name: keyof typeof aliases; properties: Shape; required: string[]; input: Shape; wire: Shape }> = [
  {
    name: 'Read',
    properties: {
      file_path: { type: 'string', minLength: 1, pattern: '^/' },
      offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 2000 },
      pages: { type: 'string', pattern: '^\\d+(-\\d+)?$' }, allow_large: { type: 'boolean', default: false },
    },
    required: ['file_path'],
    input: { file_path: '/tmp/café.txt', offset: 3, limit: 7, pages: '1-2', allow_large: true },
    wire: { path: '/tmp/café.txt', start: 3, count: 7, page_range: '1-2', allow_oversize: true },
  },
  {
    name: 'Write', properties: { file_path: { type: 'string', minLength: 1 }, content: { type: 'string', minLength: 0 } },
    required: ['file_path', 'content'], input: { file_path: '/tmp/out.txt', content: literal }, wire: { path: '/tmp/out.txt', text: literal },
  },
  {
    name: 'Edit', properties: {
      file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' },
      replace_all: { type: 'boolean', default: false },
    },
    required: ['file_path', 'old_string', 'new_string'],
    input: { file_path: '/tmp/out.txt', old_string: 'Read', new_string: 'Write', replace_all: true },
    wire: { path: '/tmp/out.txt', search: 'Read', replacement: 'Write', all_matches: true },
  },
  {
    name: 'Bash', properties: {
      command: { type: 'string', minLength: 1 }, timeout: { type: 'integer', minimum: 1, maximum: 600000 },
      description: { type: 'string' }, run_in_background: { type: 'boolean' }, dangerouslyDisableSandbox: { type: 'boolean' },
    },
    required: ['command'],
    input: { command: 'printf "Read path text skill"', timeout: 1000, description: literal, run_in_background: false, dangerouslyDisableSandbox: false },
    wire: { script: 'printf "Read path text skill"', timeout_ms: 1000, label: literal, background: false, bypass_sandbox: false },
  },
  {
    name: 'Agent', properties: {
      description: { type: 'string', maxLength: 200 }, prompt: { type: 'string', minLength: 1 },
      subagent_type: { type: 'string', enum: ['Explore', 'Plan', 'claude-code-guide', 'fork'] },
      model: { type: 'string', enum: ['opus', 'sonnet'] }, effort: { type: 'string', enum: ['high', 'max'] },
      isolation: { type: 'string', enum: ['worktree'] },
    },
    required: ['description', 'prompt'],
    input: { description: literal, prompt: literal, subagent_type: 'Explore', model: 'opus', effort: 'max', isolation: 'worktree' },
    wire: { label: literal, task: literal, agent_type: 'explorer', model: 'opus', effort: 'max', isolation: 'worktree' },
  },
  {
    name: 'Skill', properties: { skill: { type: 'string', enum: ['claude-api', 'anthropic-skills:pdf', 'humanizer'] }, args: { type: 'string' } },
    required: ['skill'], input: { skill: 'anthropic-skills:pdf', args: literal }, wire: { name: 'standard:pdf', arguments: literal },
  },
  {
    name: 'ExitPlanMode', properties: {
      allowedPrompts: { type: 'array', minItems: 1, items: {
        type: 'object', properties: { tool: { type: 'string', enum: ['Bash'] }, prompt: { type: 'string', minLength: 1 } },
        required: ['tool', 'prompt'], additionalProperties: false,
      } },
    },
    required: [],
    input: { allowedPrompts: [{ tool: 'Bash', prompt: literal }] },
    wire: { permissions: [{ tool: 'shell', prompt: literal }] },
  },
]

function tools() {
  return cases.map(entry => ({
    name: entry.name, cache_control: cache, strict: true,
    input_schema: { type: 'object', properties: entry.properties, required: entry.required, additionalProperties: false },
  }))
}

function message(content: unknown[]) {
  return { id: 'msg_parameters', type: 'message', role: 'assistant', model: 'fixture-model', content,
    stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 23, output_tokens: 7 } }
}

function event(type: string, fields: Shape = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
}

function events(text: string): Shape[] {
  return text.split('\n\n').filter(frame => frame.trim()).map(frame =>
    JSON.parse(frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')))
}

async function boundedCall(t: TestContext, server: Server, options: CallOptions, body: string | Buffer) {
  const exchange = openCall(server, options)
  const abort = () => exchange.req.destroy()
  t.signal.addEventListener('abort', abort, { once: true })
  try {
    exchange.req.end(body)
    return await exchange.finished
  } finally {
    t.signal.removeEventListener('abort', abort)
    exchange.req.destroy()
  }
}

async function until<T>(t: TestContext, promise: Promise<T>): Promise<T> {
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('Test aborted while waiting for a stream checkpoint'))
    t.signal.addEventListener('abort', abort, { once: true })
    if (t.signal.aborted) abort()
  })
  try { return await Promise.race([promise, cancelled]) }
  finally { t.signal.removeEventListener('abort', abort) }
}

function validation(schema: Shape): Shape {
  const output: Shape = {}
  for (const [key, value] of Object.entries(schema)) {
    if (['description', 'title', '$comment'].includes(key)) continue
    if (['properties', '$defs', 'definitions', 'dependentSchemas', 'patternProperties'].includes(key)) {
      output[key] = Object.fromEntries(Object.entries(value as Shape).map(([name, child]) => [name, validation(child as Shape)]))
    } else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key)) {
      output[key] = (value as Shape[]).map(validation)
    } else if (['items', 'additionalProperties', 'if', 'then', 'else', 'not', 'propertyNames'].includes(key) && value !== null && typeof value === 'object') {
      output[key] = validation(value as Shape)
    } else output[key] = value
  }
  return output
}

function expectedSchema(entry: typeof cases[number]): Shape {
  const properties = Object.fromEntries(Object.entries(entry.properties).map(([name, value]) => [keys[entry.name][name] ?? name, structuredClone(value)]))
  if (entry.name === 'Agent') properties.agent_type.enum = ['explorer', 'planner', 'client-guide', 'fork']
  if (entry.name === 'Skill') properties.name.enum = ['model-api', 'standard:pdf', 'humanizer']
  if (entry.name === 'ExitPlanMode') properties.permissions.items.properties.tool.enum = ['shell']
  return { type: 'object', properties, required: entry.required.map(name => keys[entry.name][name] ?? name).sort((a, b) => a.localeCompare(b, 'en')), additionalProperties: false }
}

test('v2 messages and count_tokens expose translated parameters with the original validation contract', TEST_OPTIONS, async (t) => {
  const seen: Shape[] = []
  const upstream = await mockServer(t, async (req, res) => {
    const bytes = await bodyOf(req)
    assert.equal(req.headers['content-length'], String(bytes.length))
    seen.push({ path: req.url, body: JSON.parse(bytes.toString()) })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"input_tokens":23}')
  })
  const proxy = await gateway(t, origin(upstream))
  const request = { model: 'fixture-model', tools: tools(), tool_choice: { type: 'tool', name: 'Read' }, messages: [{ role: 'user', content: literal }] }
  for (const suffix of ['', '/count_tokens']) {
    const response = await boundedCall(t, proxy, { ...v2, path: v2.path + suffix + '?beta=true&same=1&same=2' }, JSON.stringify(request))
    assert.equal(response.status, 200)
    assert.equal(response.complete, true)
    assert.deepEqual(JSON.parse(response.body.toString()), { input_tokens: 23 })
  }
  assert.deepEqual(seen.map(entry => entry.path), ['/v1/messages?beta=true&same=1&same=2', '/v1/messages/count_tokens?beta=true&same=1&same=2'])
  for (const { body } of seen) {
    assert.deepEqual(body.tool_choice, { type: 'tool', name: 'read_file' })
    assert.equal(body.tools.length, cases.length)
    body.tools.forEach((tool: Shape, index: number) => {
      assert.equal(tool.name, aliases[cases[index].name])
      assert.equal(tool.strict, true)
      assert.deepEqual(tool.cache_control, cache)
      assert.deepEqual(validation(tool.input_schema), expectedSchema(cases[index]))
    })
    assert.deepEqual(body.messages, request.messages)
    assert.equal(body.model, request.model)
  }
})

test('v2 JSON responses restore native arguments and replay the same wire history with signatures and cache blocks', TEST_OPTIONS, async (t) => {
  const signed = '{ "type":"thinking", "thinking":"path text skill Read", "signature":"opaque\\u002bRead/Agent==" }'
  const thinking = JSON.parse(signed)
  const redacted = { type: 'redacted_thinking', data: 'opaque-Skill==' }
  const native = cases.map(entry => ({ type: 'tool_use', id: `tool_${entry.name}`, name: entry.name, input: entry.input }))
  const wire = cases.map(entry => ({ type: 'tool_use', id: `tool_${entry.name}`, name: aliases[entry.name], input: entry.wire }))
  const wireContent = [thinking, redacted, ...wire]
  const nativeContent = [thinking, redacted, ...native]
  const received: Buffer[] = []
  const upstream = await mockServer(t, async (req, res) => {
    received.push(await bodyOf(req))
    const body = JSON.stringify(message(wireContent)).replace(JSON.stringify(thinking), signed)
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) })
    res.end(body)
  })
  const proxy = await gateway(t, origin(upstream))
  const request = {
    model: 'fixture-model', max_tokens: 2048, tools: tools(), thinking: { type: 'adaptive' }, output_config: { effort: 'max' },
    system: [{ type: 'text', text: 'Keep local files intact.', cache_control: cache }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: literal, cache_control: cache }] },
      { role: 'assistant', content: nativeContent },
      { role: 'user', content: native.map(block => ({ type: 'tool_result', tool_use_id: block.id, content: literal, cache_control: cache })) },
    ],
  }
  const response = await boundedCall(t, proxy, v2, JSON.stringify(request).replace(JSON.stringify(thinking), signed))
  assert.equal(response.status, 200)
  assert.equal(response.complete, true)
  assert.equal(response.body.includes(signed), true)
  assert.deepEqual(JSON.parse(response.body.toString()), message(nativeContent))
  assert.ok(response.headers['content-length'] === undefined || response.headers['content-length'] === String(response.body.length))
  const first = JSON.parse(received[0].toString())
  assert.equal(received[0].includes(signed), true)
  assert.deepEqual(first.messages[1].content, wireContent)
  const restored = JSON.parse(response.body.toString())
  const followup = { ...request, messages: [...request.messages, { role: 'assistant', content: restored.content }, request.messages[2]] }
  const second = await boundedCall(t, proxy, v2, JSON.stringify(followup))
  assert.equal(second.status, 200)
  assert.equal(second.complete, true)
  const replay = JSON.parse(received[1].toString())
  assert.deepEqual(replay.messages.slice(0, first.messages.length), first.messages)
  assert.deepEqual(replay.messages.at(-2).content, wireContent)
  assert.deepEqual(replay.messages.at(-1), request.messages[2])
  for (const body of [first, replay]) {
    assert.equal(body.model, request.model)
    assert.deepEqual(body.thinking, request.thinking)
    assert.deepEqual(body.output_config, request.output_config)
    assert.deepEqual(body.system, request.system)
    assert.deepEqual(body.messages[0], request.messages[0])
    assert.deepEqual(body.messages[2], request.messages[2])
    assert.deepEqual(body.tools.map((tool: Shape) => tool.cache_control), tools().map(tool => tool.cache_control))
  }
})

test('v2 preserves 64-bit numeric lexemes, primitive inputs and nested literal parameter names', TEST_OPTIONS, async (t) => {
  const nativeInput = `{"file_path":"/tmp/Read.txt","offset":9223372036854775807,"limit":1e+03,"literal":${JSON.stringify(nestedLiteral)}}`
  const wireInput = nativeInput.replace('"file_path":"/tmp/Read.txt"', '"path":"/tmp/Read.txt"').replace('"offset":', '"start":').replace('"limit":', '"count":')
  const primitives = ['9223372036854775807', '-0', '1e+03', 'null', 'false', '"path text skill"', '[{"path":"literal","text":"literal","skill":"claude-api"}]']
  const blocks = (input: string, name: string) => [input, ...primitives].map((value, index) => `{"type":"tool_use","id":"literal_${index}","name":"${name}","input":${value}}`).join(',')
  let received = ''
  const upstream = await mockServer(t, async (req, res) => {
    received = (await bodyOf(req)).toString()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(`{"type":"message","content":[${blocks(wireInput, 'read_file')}]}`)
  })
  const proxy = await gateway(t, origin(upstream))
  const response = await boundedCall(t, proxy, v2, `{"tools":${JSON.stringify([tools()[0]])},"messages":[{"role":"assistant","content":[${blocks(nativeInput, 'Read')}]}]}`)
  assert.equal(response.status, 200)
  assert.equal(response.complete, true)
  assert.ok(received.includes(wireInput), 'request inputs retain literal bytes outside renamed keys')
  assert.ok(response.body.includes(nativeInput), 'response inputs retain literal bytes outside renamed keys')
  for (const value of primitives) {
    assert.ok(received.includes(`"input":${value}`), value)
    assert.ok(response.body.includes(`"input":${value}`), value)
  }
})

test('all 23 v2 capabilities keep their canonical schema and argument contract', TEST_OPTIONS, async (t) => {
  assert.equal(Object.keys(aliases).length, 23)
  assert.deepEqual(Object.keys(PARAMETER_ALIASES).sort(), Object.keys(aliases).sort())
  const definitions = Object.keys(aliases).map(name => {
    const fields = Object.keys(PARAMETER_ALIASES[name])
    return { name, description: 'Claude Code tool. Use only after checking permissions.', strict: true, cache_control: cache,
      input_schema: { type: 'object', properties: Object.fromEntries(fields.map(field => [field, {
        type: 'string',
        ...((name === 'Agent' && field === 'subagent_type') || (name === 'Skill' && field === 'skill')
          ? {} : { minLength: 1, maxLength: 500 }),
        default: 'literal', examples: ['path text skill'],
      }])), required: fields, additionalProperties: false } }
  })
  const codec = createWireCodec({ tools: definitions }, 'neutral-v2')
  const native = definitions.map(tool => ({ type: 'tool_use', id: `capability_${tool.name}`, name: tool.name,
    input: Object.fromEntries(Object.keys(tool.input_schema.properties).map(key => [key, 'literal'])) }))
  let received: Shape | undefined
  const upstream = await mockServer(t, async (req, res) => {
    received = JSON.parse((await bodyOf(req)).toString())
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(message(received!.messages[0].content)))
  })
  const proxy = await gateway(t, origin(upstream))
  const response = await boundedCall(t, proxy, v2, JSON.stringify({ tools: definitions, messages: [{ role: 'assistant', content: native }] }))
  assert.equal(response.status, 200, response.body.toString())
  assert.equal(response.complete, true)
  assert.deepEqual(JSON.parse(response.body.toString()).content, native)
  assert.equal(received!.tools.length, 23)
  definitions.forEach((tool, index) => {
    const wire = received!.tools[index]
    assert.equal(wire.name, aliases[tool.name as keyof typeof aliases])
    assert.equal(wire.strict, true)
    assert.deepEqual(wire.cache_control, cache)
    assert.equal(typeof wire.description, 'string')
    assert.doesNotMatch(wire.description, /Claude Code|Claude Agent SDK/)
    const schema = validation(wire.input_schema)
    assert.deepEqual(schema, validation(codec.encodeToolSchema(tool.name, tool.input_schema) as Shape))
    const restored = { ...schema,
      properties: Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [codec.decodeInputKey(tool.name, key), value])),
      required: schema.required.map((key: string) => codec.decodeInputKey(tool.name, key)).sort(),
    }
    assert.deepEqual(restored, { ...tool.input_schema, required: [...tool.input_schema.required].sort() }, tool.name)
    for (const [key, alias] of Object.entries(PARAMETER_ALIASES[tool.name])) {
      assert.equal(codec.encodeInputKey(tool.name, key), alias)
      assert.equal(codec.decodeInputKey(tool.name, alias), key)
    }
  })
})

test('v2 streams partial Write keys and a large Agent task as native arguments before block stop', TEST_OPTIONS, async (t) => {
  const release = deferred()
  const earlyContent = deferred()
  t.after(() => release.resolve())
  const writeText = 'Write-prefix café ' + 'path text skill Read '.repeat(5000)
  const agentTask = 'Agent-prefix café ' + 'file_path content prompt Read '.repeat(12000)
  const wireInputs = [
    JSON.stringify({ path: '/tmp/café.txt', text: writeText }),
    JSON.stringify({ task: agentTask, agent_type: 'explorer', label: 'Search source', model: 'opus', effort: 'max', isolation: 'worktree', literal: nestedLiteral }),
  ]
  const nativeInputs = [
    JSON.stringify({ file_path: '/tmp/café.txt', content: writeText }),
    JSON.stringify({ prompt: agentTask, subagent_type: 'Explore', description: 'Search source', model: 'opus', effort: 'max', isolation: 'worktree', literal: nestedLiteral }),
  ]
  const cuts = [
    [0, 4, 7, wireInputs[0].indexOf('"text"') + 3, wireInputs[0].indexOf('"text"') + 5, 4096],
    [0, 3, 6, 9, 32, 4096],
  ]
  const upstream = await mockServer(t, async (req, res) => {
    await bodyOf(req)
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    for (let index = 0; index < 2; index++) res.write(event('content_block_start', {
      index, content_block: { type: 'tool_use', id: `stream_${index}`, name: ['write_file', 'delegate'][index], input: {} },
    }))
    for (let part = 0; part < cuts[0].length - 1; part++) {
      for (let index = 0; index < 2; index++) {
        res.write(event('content_block_delta', { index, delta: {
          type: 'input_json_delta', partial_json: wireInputs[index].slice(cuts[index][part], cuts[index][part + 1]),
        } }))
      }
      await nextTurn()
    }
    await release.promise
    for (let offset = 4096; offset < Math.max(...wireInputs.map(input => input.length)); offset += 8192) {
      for (let index = 0; index < 2; index++) if (offset < wireInputs[index].length) {
        res.write(event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: wireInputs[index].slice(offset, offset + 8192) } }))
      }
      await nextTurn()
    }
    res.end(event('content_block_stop', { index: 1 }) + event('content_block_stop', { index: 0 }) + event('message_stop'))
  })
  const proxy = await gateway(t, origin(upstream))
  let early = ''
  let completed = false
  const decoder = new StringDecoder('utf8')
  const exchange = openCall(proxy, { ...v2, onResponse: response => {
    response.on('data', (chunk: Buffer) => {
      early += decoder.write(chunk)
      if (early.includes('Write-prefix') && early.includes('Agent-prefix')) earlyContent.resolve()
    })
  } })
  t.after(() => exchange.req.destroy())
  void exchange.finished.then(() => { completed = true }, () => { completed = true })
  exchange.req.end(JSON.stringify({ tools: tools(), stream: true }))
  try {
    await until(t, earlyContent.promise)
    assert.equal(completed, false)
    const earlyFrames = events(early.slice(0, early.lastIndexOf('\n\n') + 2))
    assert.equal(earlyFrames.some(frame => frame.type === 'content_block_stop'), false)
    const prefixes = [0, 1].map(index => earlyFrames.filter(frame => frame.index === index && frame.type === 'content_block_delta').map(frame => frame.delta.partial_json).join(''))
    assert.match(prefixes[0], /^\{"file_path":.*,"content":"Write-prefix/)
    assert.match(prefixes[1], /^\{"prompt":"Agent-prefix/)
  } finally { release.resolve() }
  const response = await until(t, exchange.finished)
  assert.equal(response.status, 200)
  assert.equal(response.complete, true)
  const frames = events(response.body.toString())
  assert.deepEqual(frames.filter(frame => frame.type === 'content_block_start').map(frame => frame.content_block.name), ['Write', 'Agent'])
  const accumulated = ['', '']
  const stopped = new Set<number>()
  for (const frame of frames) {
    if (frame.type === 'content_block_delta') {
      assert.equal(stopped.has(frame.index), false)
      accumulated[frame.index] += frame.delta.partial_json
      assert.ok(nativeInputs[frame.index].startsWith(accumulated[frame.index]), 'every emitted prefix must already use native keys')
    }
    if (frame.type === 'content_block_stop') {
      assert.deepEqual(JSON.parse(accumulated[frame.index]), JSON.parse(nativeInputs[frame.index]))
      stopped.add(frame.index)
    }
  }
  assert.deepEqual(accumulated, nativeInputs)
  assert.deepEqual([...stopped], [1, 0])
})

test('v2 SSE restores permission keys and tool selectors across split tokens', TEST_OPTIONS, async (t) => {
  const input = JSON.stringify({ permissions: [{ tool: 'shell', prompt: literal, literal: nestedLiteral }], literal: nestedLiteral })
  const upstream = await mockServer(t, async (req, res) => {
    await bodyOf(req)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(event('content_block_start', { index: 3, content_block: { type: 'tool_use', id: 'plan', name: 'finish_planning', input: {} } }))
    for (let offset = 0; offset < input.length; offset += 3) res.write(event('content_block_delta', {
      index: 3, delta: { type: 'input_json_delta', partial_json: input.slice(offset, offset + 3) },
    }))
    res.end(event('content_block_stop', { index: 3 }) + event('message_stop'))
  })
  const proxy = await gateway(t, origin(upstream))
  const response = await boundedCall(t, proxy, v2, JSON.stringify({ tools: tools(), stream: true }))
  assert.equal(response.status, 200)
  assert.equal(response.complete, true)
  const frames = events(response.body.toString())
  assert.equal(frames[0].content_block.name, 'ExitPlanMode')
  const collected = frames.filter(frame => frame.type === 'content_block_delta').map(frame => frame.delta.partial_json).join('')
  assert.deepEqual(JSON.parse(collected), { allowedPrompts: [{ tool: 'Bash', prompt: literal, literal: nestedLiteral }], literal: nestedLiteral })
})

test('concurrent v2, v1 and root requests keep parameter and tool codecs isolated', TEST_OPTIONS, async (t) => {
  const allArrived = deferred()
  t.after(() => allArrived.resolve())
  const received = new Map<string, Shape>()
  const upstream = await mockServer(t, async (req, res) => {
    const request = JSON.parse((await bodyOf(req)).toString())
    const mode = new URL(req.url!, 'http://fixture.test').searchParams.get('mode')!
    received.set(mode, request)
    if (received.size === 4) allArrived.resolve()
    await allArrived.promise
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(message([{ type: 'tool_use', id: 'read', name: mode === 'root' ? 'Read' : 'read_file',
      input: mode === 'v2' || mode === 'custom' ? { path: '/tmp/out', literal: nestedLiteral } : { file_path: '/tmp/out', literal: nestedLiteral } }])))
  })
  const proxy = await gateway(t, origin(upstream))
  const native = { tools: [tools()[0]], messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 'Read', input: { file_path: '/tmp/in', literal: nestedLiteral } }] }] }
  const requests = [
    { mode: 'v2', path: '/agent-v2/v1/messages', body: native },
    { mode: 'v1', path: '/agent/v1/messages', body: native },
    { mode: 'root', path: '/v1/messages', body: native },
    { mode: 'custom', path: '/agent-v2/v1/messages', body: { tools: [{ name: 'read_file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 'read_file', input: { path: '/tmp/in', literal: nestedLiteral } }] }] } },
  ]
  const responses = await Promise.all(requests.map(async request => ({ mode: request.mode,
    response: await boundedCall(t, proxy, { ...v2, path: request.path + '?mode=' + request.mode }, JSON.stringify(request.body)),
  })))
  assert.equal(received.size, 4)
  for (const { mode, response } of responses) {
    assert.equal(response.status, 200)
    assert.equal(response.complete, true)
    assert.deepEqual(JSON.parse(response.body.toString()).content, [{ type: 'tool_use', id: 'read', name: mode === 'custom' ? 'read_file' : 'Read',
      input: mode === 'custom' ? { path: '/tmp/out', literal: nestedLiteral } : { file_path: '/tmp/out', literal: nestedLiteral } }])
    const wire = received.get(mode)!
    assert.equal(wire.tools[0].name, mode === 'root' ? 'Read' : 'read_file')
    assert.deepEqual(wire.messages[0].content[0].input, mode === 'v2' || mode === 'custom'
      ? { path: '/tmp/in', literal: nestedLiteral } : { file_path: '/tmp/in', literal: nestedLiteral })
    assert.ok(Object.hasOwn(wire.tools[0].input_schema.properties, mode === 'v2' || mode === 'custom' ? 'path' : 'file_path'))
  }
})

test('v2 rejects ambiguous input keys and schemas before contacting upstream', TEST_OPTIONS, async (t) => {
  let requests = 0
  const upstream = await mockServer(t, (req, res) => { requests++; req.resume(); res.end('{}') })
  const proxy = await gateway(t, origin(upstream))
  const schema = { ...tools()[0], input_schema: {
    type: 'object', properties: { file_path: { type: 'string' }, path: { type: 'string' } }, required: ['file_path', 'path'], additionalProperties: false,
  } }
  for (const path of ['/agent-v2/v1/messages', '/agent-v2/v1/messages/count_tokens']) {
    for (const body of [
      { tools: [schema], messages: [] },
      { tools: [tools()[0]], messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'collision', name: 'Read', input: { file_path: '/tmp/native', path: '/tmp/alias' } }] }] },
    ]) {
      const response = await boundedCall(t, proxy, { ...v2, path }, JSON.stringify(body))
      assert.equal(response.status, 400)
      assert.equal(response.complete, true)
      assert.equal(JSON.parse(response.body.toString()).error.type, 'invalid_request_error')
      assert.doesNotMatch(response.body.toString(), /"type":"tool_use"|\/tmp\/native|\/tmp\/alias/)
    }
  }
  assert.equal(requests, 0)
})

test('v2 never exposes ambiguous upstream JSON arguments as a complete tool call', TEST_OPTIONS, async (t) => {
  const upstream = await mockServer(t, async (req, res) => {
    await bodyOf(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(message([{ type: 'tool_use', id: 'collision', name: 'read_file', input: { file_path: '/tmp/native-secret', path: '/tmp/alias-secret' } }])))
  })
  const proxy = await gateway(t, origin(upstream))
  const response = await boundedCall(t, proxy, v2, JSON.stringify({ tools: [tools()[0]] }))
  if (response.complete) {
    assert.equal(response.status, 502)
    assert.equal(JSON.parse(response.body.toString()).error.type, 'api_error')
  } else assert.equal(response.status, 200)
  assert.doesNotMatch(response.body.toString(), /native-secret|alias-secret|"type":"tool_use"/)
})

test('v2 gzip requests and responses translate arguments and remove stale representation headers', TEST_OPTIONS, async (t) => {
  let received: Shape | undefined
  const upstream = await mockServer(t, async (req, res) => {
    const compressed = await bodyOf(req)
    assert.equal(req.headers['content-length'], String(compressed.length))
    assert.equal(req.headers['content-encoding'], 'gzip')
    received = JSON.parse(gunzipSync(compressed).toString())
    const body = gzipSync(JSON.stringify(message([{ type: 'tool_use', id: 'gzip', name: 'write_file', input: { path: '/tmp/café.txt', text: literal } }])))
    res.writeHead(200, {
      'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(body.length),
      etag: '"stale"', digest: 'sha-256=stale', 'request-id': 'gzip-fixture',
    })
    res.end(body)
  })
  const proxy = await gateway(t, origin(upstream))
  const request = { tools: [tools()[1]], messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 'Write', input: { file_path: '/tmp/input', content: literal } }] }] }
  const compressed = gzipSync(JSON.stringify(request))
  const response = await boundedCall(t, proxy, { ...v2, headers: { ...v2.headers, 'content-encoding': 'gzip', 'content-length': String(compressed.length), 'accept-encoding': 'gzip' } }, compressed)
  assert.equal(response.status, 200)
  assert.equal(response.complete, true)
  assert.deepEqual(received!.messages[0].content[0], { type: 'tool_use', id: 'old', name: 'write_file', input: { path: '/tmp/input', text: literal } })
  assert.deepEqual(JSON.parse(response.body.toString()).content, [{ type: 'tool_use', id: 'gzip', name: 'Write', input: { file_path: '/tmp/café.txt', content: literal } }])
  for (const header of ['content-encoding', 'etag', 'digest']) assert.equal(response.headers[header], undefined)
  assert.ok(response.headers['content-length'] === undefined || response.headers['content-length'] === String(response.body.length))
  assert.equal(response.headers['request-id'], 'gzip-fixture')
})

test('v2 upstream error statuses and bodies bypass translation byte for byte', TEST_OPTIONS, async (t) => {
  const payload = Buffer.from('{ "type":"error", "error":{"type":"invalid_request_error","message":"read_file path text skill"}, "content":[{"type":"tool_use","name":"read_file","input":{"path":"/tmp/error"}}] }')
  const compressed = gzipSync(payload)
  const upstream = await mockServer(t, async (req, res) => {
    await bodyOf(req)
    const encoded = req.url!.includes('gzip')
    const body = encoded ? compressed : payload
    res.writeHead(encoded ? 429 : 400, {
      'content-type': 'application/json', 'content-length': String(body.length),
      ...(encoded ? { 'content-encoding': 'gzip' } : {}),
      etag: '"unchanged"', 'retry-after': '17', 'request-id': 'error-fixture',
    })
    res.end(body)
  })
  const proxy = await gateway(t, origin(upstream))
  for (const encoded of [false, true]) {
    const response = await boundedCall(t, proxy, { ...v2, path: v2.path + (encoded ? '?gzip=1' : '') }, JSON.stringify({ tools: tools() }))
    const expected = encoded ? compressed : payload
    assert.equal(response.status, encoded ? 429 : 400)
    assert.equal(response.complete, true)
    assert.deepEqual(response.body, expected)
    assert.equal(response.headers['content-length'], String(expected.length))
    assert.equal(response.headers['content-encoding'], encoded ? 'gzip' : undefined)
    assert.equal(response.headers.etag, '"unchanged"')
    assert.equal(response.headers['retry-after'], '17')
    assert.equal(response.headers['request-id'], 'error-fixture')
  }
})
