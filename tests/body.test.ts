import assert from 'node:assert/strict'
import { test } from 'node:test'
import { brotliCompressSync, brotliDecompressSync, deflateSync, gzipSync, gunzipSync, inflateSync, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { BodyError, CONTEXT_ATTRIBUTION, PRIVATE_CONTEXT_ATTRIBUTION, prepareNeutralRequest, rewriteRequestBody } from '../src/body.js'
import { PARAMETER_ALIASES } from '../src/parameter-profile.js'
import { TOOL_DESCRIPTIONS } from '../src/tool-descriptions.js'

const limit = 1024 * 1024
const context = `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# gitStatus\nWorking directory: /home/real/project\n\n${CONTEXT_ATTRIBUTION} It describes the user's own account and workspace.\n</system-reminder>\n`
const rewrite = (body: string | Buffer, path = '/v1/messages', encoding?: string, max = limit) =>
  rewriteRequestBody(Buffer.from(body), path, encoding, max)

test('only the optional root user identifier is removed; empty metadata is omitted', async () => {
  for (const user_id of ['opaque-session', null, { nested: 'value' }]) {
    const result = await rewrite(JSON.stringify({ metadata: { user_id }, model: 'model', messages: [] }))
    assert.deepEqual(JSON.parse(result.toString()), { model: 'model', messages: [] })
  }
  const kept = await rewrite('{"metadata":{"user_id":"private","future":"keep"},"user_id":"outside-metadata"}')
  assert.deepEqual(JSON.parse(kept.toString()), { metadata: { future: 'keep' }, user_id: 'outside-metadata' })
})

test('unrelated JSON bytes, numeric literals, signatures and nested metadata are not reserialized', async () => {
  const untouched = '"tools" : [ { "input" : { "number":9007199254740993, "metadata":{"user_id":"tool-data"}, "signature":"\\u0061" } } ]'
  const result = (await rewrite(`{ "metadata": {"user_id":"remove"}, ${untouched} }`)).toString()
  assert.ok(result.includes(untouched))
  assert.equal(JSON.parse(result).metadata, undefined)
})

test('the context attribution changes without altering instructions, paths, or normal quoted text', async () => {
  const payload = {
    metadata: { user_id: 'remove' },
    system: [{ type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: context }, { type: 'text', text: `Quote: ${CONTEXT_ATTRIBUTION}` }] },
      { role: 'assistant', content: [{ type: 'text', text: context }, { type: 'thinking', thinking: context, signature: 'signed' }] },
      { role: 'user', content: [{ type: 'tool_result', content: context, tool_use_id: 'tool' }] },
    ],
  }
  const result = JSON.parse((await rewrite(JSON.stringify(payload))).toString())
  const expected = {
    system: payload.system,
    messages: [
      { ...payload.messages[0], content: [{ type: 'text', text: context.replace(CONTEXT_ATTRIBUTION, PRIVATE_CONTEXT_ATTRIBUTION) }, payload.messages[0].content[1]] },
      ...payload.messages.slice(1),
    ],
  }
  assert.deepEqual(result, expected)
})

test('unchanged bodies retain exact bytes and the policy is idempotent', async () => {
  for (const text of ['{ "messages": [], "number":9007199254740993 }', 'not JSON', '', '{"metadata":{}}']) {
    assert.equal((await rewrite(text)).toString(), text)
  }
  const first = await rewrite(JSON.stringify({ metadata: { user_id: 'id' }, messages: [{ role: 'user', content: context }] }))
  assert.deepEqual(await rewrite(first), first)
})

test('count-token messages use the same policy; unrelated endpoints stay untouched', async () => {
  const input = '{"metadata":{"user_id":"private"},"messages":[]}'
  assert.equal(JSON.parse((await rewrite(input, '/v1/messages/count_tokens')).toString()).metadata, undefined)
  assert.equal((await rewrite(input, '/v1/files')).toString(), input)
  assert.equal((await rewrite(input, '/v1/messages/batches')).toString(), input)
})

test('ambiguous privacy fields are rejected', async () => {
  for (const text of [
    '{"metadata":{"user_id":"first"},"metadata":{"user_id":"second"}}',
    '{"metadata":{"user_id":"first","user_id":"second"}}',
  ]) {
    await assert.rejects(rewrite(text), error => error instanceof BodyError && error.status === 400)
  }
})

for (const [name, encode, decode] of [
  ['gzip', gzipSync, gunzipSync], ['deflate', deflateSync, inflateSync],
  ['br', brotliCompressSync, brotliDecompressSync], ['zstd', zstdCompressSync, zstdDecompressSync],
] as const) {
  test(`the body policy supports ${name} and preserves unchanged compressed bytes`, async () => {
    const input = encode(Buffer.from('{"metadata":{"user_id":"private"},"model":"test"}'))
    const result = await rewrite(input, '/v1/messages', name)
    assert.deepEqual(JSON.parse(decode(result).toString()), { model: 'test' })
    const plain = encode(Buffer.from('{ "model": "test" }'))
    assert.deepEqual(await rewrite(plain, '/v1/messages', name), plain)
  })
}

test('encoding chains retain their order and decoded bodies remain bounded', async () => {
  const input = brotliCompressSync(gzipSync(Buffer.from('{"metadata":{"user_id":"private"},"keep":true}')))
  const result = await rewrite(input, '/v1/messages', 'gzip, br')
  assert.deepEqual(JSON.parse(gunzipSync(brotliDecompressSync(result)).toString()), { keep: true })
  const oversized = gzipSync(Buffer.from(JSON.stringify({ metadata: { user_id: 'x'.repeat(2000) } })))
  await assert.rejects(rewrite(oversized, '/v1/messages', 'gzip', 100), error => error instanceof BodyError && error.status === 413)
  await assert.rejects(rewrite('{}', '/v1/messages', 'unknown'), error => error instanceof BodyError && error.status === 415)
  await assert.rejects(rewrite('not gzip', '/v1/messages', 'gzip'), error => error instanceof BodyError && error.status === 400)
})

const neutral = (body: string | Buffer, path = '/v1/messages', encoding?: string, max = limit) =>
  prepareNeutralRequest(Buffer.from(body), path, encoding, max)
const aliases = {
  Agent: 'delegate', AskUserQuestion: 'ask_user', Bash: 'shell', CronCreate: 'schedule_job',
  CronDelete: 'cancel_job', CronList: 'list_jobs', Edit: 'edit_file', EnterPlanMode: 'begin_planning',
  EnterWorktree: 'enter_workspace', ExitPlanMode: 'finish_planning', ExitWorktree: 'leave_workspace',
  ListAgents: 'list_agents', NotebookEdit: 'edit_notebook', Read: 'read_file', ReportFindings: 'report_findings',
  ScheduleWakeup: 'schedule_wakeup', SendMessage: 'send_message', Skill: 'load_skill', TaskStop: 'stop_task',
  WebFetch: 'fetch_url', WebSearch: 'search_web', Workflow: 'run_workflow', Write: 'write_file',
}

function definition(name: string) {
  return { name, description: `Use the ${name} tool. Keep permission checks and all limits.`, input_schema: { type: 'object', properties: {} } }
}

test('neutral profile translates all stock definitions without dropping their contracts', async () => {
  const tools = Object.keys(aliases).map(definition)
  const { body, codec } = await neutral(JSON.stringify({ tools, tool_choice: { type: 'tool', name: 'Bash' }, messages: [] }))
  const result = JSON.parse(body.toString())
  assert.equal(codec.profileId, 'neutral-v1')
  assert.equal(codec.active, true)
  assert.equal(result.tools.length, 23)
  for (const [index, [name, alias]] of Object.entries(aliases).entries()) {
    assert.equal(result.tools[index].name, alias)
    assert.equal(result.tools[index].description, `Use the ${alias} tool. Keep permission checks and all limits.`)
    assert.deepEqual(result.tools[index].input_schema, tools[index].input_schema)
    assert.equal(codec.decodeTool(alias), name)
  }
  assert.equal(result.tool_choice.name, 'shell')
})

test('schema annotations and selector enums change only at their semantic paths', async () => {
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', required: ['allowedPrompts'], additionalProperties: false,
    properties: {
      allowedPrompts: { type: 'array', items: { type: 'object', properties: {
        tool: { type: 'string', enum: ['Bash'], description: 'Use the Bash tool.' },
        prompt: { type: 'string', examples: ['Bash'], default: 'Bash' },
      } } },
      literal: { enum: ['Bash'], description: 'Use the Bash tool.' },
      description: { type: 'string', default: 'Use the Bash tool.' },
    },
    examples: [{ description: 'Use the Bash tool.', allowedPrompts: [{ tool: 'Bash' }] }],
  }
  const tools = [definition('Bash'), { ...definition('ExitPlanMode'), input_schema: schema },
    { ...definition('Agent'), input_schema: { properties: { subagent_type: { enum: ['claude', 'claude-code-guide', 'Explore', 'Plan', 'custom'] } } } },
    { ...definition('Skill'), input_schema: { properties: { skill: { enum: ['claude-api', 'anthropic-skills:pdf', 'custom'] } } } }]
  const result = JSON.parse((await neutral(JSON.stringify({ tools, messages: [] }))).body.toString())
  const updated = result.tools[1].input_schema
  assert.equal(updated.$schema, schema.$schema)
  assert.deepEqual(updated.required, schema.required)
  assert.equal(updated.additionalProperties, false)
  assert.deepEqual(updated.properties.allowedPrompts.items.properties.tool.enum, ['shell'])
  assert.equal(updated.properties.allowedPrompts.items.properties.tool.description, 'Use the shell tool.')
  assert.deepEqual(updated.properties.literal.enum, ['Bash'])
  assert.equal(updated.properties.description.default, 'Use the Bash tool.')
  assert.deepEqual(updated.examples, schema.examples)
  assert.deepEqual(updated.properties.allowedPrompts.items.properties.prompt, schema.properties.allowedPrompts.items.properties.prompt)
  assert.deepEqual(result.tools[2].input_schema.properties.subagent_type.enum, ['assistant', 'client-guide', 'explorer', 'planner', 'custom'])
  assert.deepEqual(result.tools[3].input_schema.properties.skill.enum, ['model-api', 'standard:pdf', 'custom'])
})

test('history names, exact argument selectors and tool-search references agree with response inversion', async () => {
  const tools = ['Agent', 'Skill', 'ExitPlanMode', 'Bash'].map(definition)
  const calls = [
    { type: 'tool_use', id: 'agent', name: 'Agent', input: { subagent_type: 'Explore', prompt: 'Use Bash and claude-api literally', nested: { subagent_type: 'Plan' } } },
    { type: 'tool_use', id: 'skill', name: 'Skill', input: { skill: 'anthropic-skills:pdf', args: 'claude-api' } },
    { type: 'tool_use', id: 'plan', name: 'ExitPlanMode', input: { allowedPrompts: [{ tool: 'Bash', prompt: 'Bash must remain literal' }] } },
  ]
  const provider = { type: 'server_tool_use', name: 'Bash', id: 'provider', input: { subagent_type: 'Explore' } }
  const data = { type: 'text', text: 'Bash', name: 'Bash', input: { skill: 'claude-api' } }
  const request = { tools, messages: [
    { role: 'assistant', content: [...calls, provider, { type: 'text', text: 'Use Bash' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'agent', content: [
      { type: 'tool_reference', tool_name: 'Bash' },
      { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'Agent' }] }, data,
    ] }, { type: 'tool_search_tool_result', tool_use_id: 'search', content: {
      type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'Skill' }],
    } }] },
  ] }
  const { body, codec } = await neutral(JSON.stringify(request))
  const result = JSON.parse(body.toString())
  for (const [index, call] of calls.entries()) {
    const encoded = result.messages[0].content[index]
    assert.equal(codec.decodeTool(encoded.name), call.name)
    assert.deepEqual(codec.translateInput(call.name, encoded.input, 'decode'), call.input)
  }
  assert.equal(result.messages[0].content[0].input.subagent_type, 'explorer')
  assert.equal(result.messages[0].content[1].input.skill, 'standard:pdf')
  assert.equal(result.messages[0].content[2].input.allowedPrompts[0].tool, 'shell')
  assert.deepEqual(result.messages[0].content[3], provider)
  assert.equal(result.messages[1].content[0].content[0].tool_name, 'shell')
  assert.equal(result.messages[1].content[0].content[1].tool_references[0].tool_name, 'delegate')
  assert.equal(result.messages[1].content[1].content.tool_references[0].tool_name, 'load_skill')
  assert.deepEqual(result.messages[1].content[0].content[2], data)
})

test('neutral range edits preserve numeric lexemes, opaque signatures and literal user data', async () => {
  const opaque = '{"type":"thinking", "thinking":"Use Bash", "signature":"\\u0061"}'
  const input = '{ "subagent_type":"Explore", "count":9007199254740993, "prompt":"Bash .claude claude-api", "data":{"name":"Agent","subagent_type":"Plan"} }'
  const request = `{"tools":[${JSON.stringify(definition('Agent'))}],"messages":[{"role":"assistant","content":[${opaque},{"type":"tool_use","name":"Agent","input":${input}}]},{"role":"user","content":"Bash .claude claude-api"}],"thinking":{"type":"adaptive"},"output_config":{"effort":"high"}}`
  const result = (await neutral(request)).body.toString()
  assert.ok(result.includes(opaque))
  assert.ok(result.includes(input.replace('"subagent_type":"Explore"', '"subagent_type":"explorer"')))
  assert.ok(result.includes('"thinking":{"type":"adaptive"},"output_config":{"effort":"high"}'))
  assert.ok(result.includes('"role":"user","content":"Bash .claude claude-api"'))
})

test('unknown and provider-defined tools keep all descriptions, schemas and inputs', async () => {
  const tools = [definition('MyTool'), { ...definition('Bash'), type: 'bash_20250124' }]
  const request = { tools, messages: [{ role: 'assistant', content: [{ type: 'tool_use', name: 'MyTool', input: { skill: 'claude-api', name: 'Bash' } }] }] }
  const text = JSON.stringify(request)
  assert.equal((await neutral(text)).body.toString(), text)
})

test('neutral validation rejects malformed JSON and duplicate structural selectors', async () => {
  const prefix = `"tools":[${JSON.stringify(definition('Agent'))}],`
  for (const text of ['', 'not JSON', '[]', '{"messages":[],}', '{/*comment*/"messages":[]}',
    '{"messages":[],"messages":[]}', '{"tools":[{"name":"Agent","name":"Bash"}]}',
    '{"messages":[{"role":"user","role":"assistant","content":[]}]}',
    `{${prefix}"messages":[{"role":"assistant","content":[{"type":"tool_use","name":"Agent","input":{"subagent_type":"Explore","subagent_type":"Plan"}}]}]}`,
    '{"tool_choice":{"type":"tool","name":"Bash","name":"Read"}}',
  ]) await assert.rejects(neutral(text), error => error instanceof BodyError && error.status === 400)
  await assert.rejects(neutral(Buffer.from([0xff])), error => error instanceof BodyError && error.status === 400)
})

test('neutral messages and count_tokens match, including identity-only requests and cache controls', async () => {
  const request = { system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: 'ephemeral', ttl: '1h' } }], messages: [] }
  const text = JSON.stringify(request)
  const first = await neutral(text)
  assert.deepEqual((await neutral(text, '/v1/messages/count_tokens')).body, first.body)
  assert.equal(first.codec.active, false)
  const result = JSON.parse(first.body.toString())
  assert.equal(result.system[0].text, "You are a coding assistant working in the user's local environment.")
  assert.deepEqual(result.system[0].cache_control, request.system[0].cache_control)
  assert.equal((await neutral(text, '/v1/files')).body.toString(), text)
})

for (const [name, encode, decode] of [
  ['gzip', gzipSync, gunzipSync], ['deflate', deflateSync, inflateSync],
  ['br', brotliCompressSync, brotliDecompressSync], ['zstd', zstdCompressSync, zstdDecompressSync],
] as const) {
  test(`neutral profile shares bounded ${name} transport`, async () => {
    const input = encode(Buffer.from(JSON.stringify({ tools: [definition('Bash')], messages: [] })))
    assert.equal(JSON.parse(decode((await neutral(input, '/v1/messages', name)).body).toString()).tools[0].name, 'shell')
    const plain = encode(Buffer.from('{ "messages": [] }'))
    assert.deepEqual((await neutral(plain, '/v1/messages', name)).body, plain)
    await assert.rejects(neutral(encode(Buffer.from(' '.repeat(300) + '{}')), '/v1/messages', name, 100), error => error instanceof BodyError && error.status === 413)
  })
}

test('neutral profile retains encoding chains and rejects unsupported compression', async () => {
  const request = JSON.stringify({ tools: [definition('Bash')], messages: [] })
  const encoded = brotliCompressSync(gzipSync(Buffer.from(request)))
  const result = await neutral(encoded, '/v1/messages', 'gzip, br')
  assert.equal(JSON.parse(gunzipSync(brotliDecompressSync(result.body)).toString()).tools[0].name, 'shell')
  await assert.rejects(neutral('{}', '/v1/messages', 'unknown'), error => error instanceof BodyError && error.status === 415)
  await assert.rejects(neutral('not gzip', '/v1/messages', 'gzip'), error => error instanceof BodyError && error.status === 400)
})

const neutralV2 = (body: string | Buffer, path = '/v1/messages', encoding?: string, max = limit) =>
  prepareNeutralRequest(Buffer.from(body), path, encoding, max, 'neutral-v2')

test('v2 curates all stock tools while the default and explicit v1 remain identical', async () => {
  const tools = Object.keys(aliases).map(name => ({ ...definition(name), description: 'Claude Code tool description.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  }))
  const text = JSON.stringify({ tools, messages: [] })
  const v1 = await neutral(text)
  assert.deepEqual((await prepareNeutralRequest(Buffer.from(text), '/v1/messages', undefined, limit, 'neutral-v1')).body, v1.body)
  const { body, codec } = await neutralV2(text)
  assert.equal(codec.profileId, 'neutral-v2')
  const result = JSON.parse(body.toString())
  for (const [index, name] of Object.keys(aliases).entries()) {
    assert.equal(result.tools[index].name, aliases[name as keyof typeof aliases])
    assert.equal(result.tools[index].description, TOOL_DESCRIPTIONS[name as keyof typeof TOOL_DESCRIPTIONS])
    assert.equal(result.tools[index].input_schema.additionalProperties, false)
    assert.doesNotMatch(result.tools[index].description, /claude|anthropic|\.claude/i)
  }
})

test('v2 maps every known historical input key and preserves nested literal objects on roundtrip', async () => {
  const tools = Object.keys(aliases).map(definition)
  const calls = Object.entries(PARAMETER_ALIASES).map(([name, keys]) => ({
    type: 'tool_use', name, id: `call-${name}`,
    input: Object.fromEntries([...Object.keys(keys).map(key => [key, `literal ${key}`]), ['unknown', { command: 'literal', file_path: 'literal', subagent_type: 'Plan', allowedPrompts: [{ tool: 'Bash' }] }]]),
  }))
  const { body, codec } = await neutralV2(JSON.stringify({ tools, messages: [{ role: 'assistant', content: calls }] }))
  const result = JSON.parse(body.toString())
  for (const [index, call] of calls.entries()) {
    const actual = result.messages[0].content[index]
    assert.equal(codec.decodeTool(actual.name), call.name)
    assert.deepEqual(codec.translateInput(call.name, actual.input, 'decode'), call.input)
    for (const key of Object.keys(PARAMETER_ALIASES[call.name])) {
      assert.ok(Object.hasOwn(actual.input, codec.encodeInputKey(call.name, key)), `${call.name}.${key}`)
    }
    assert.deepEqual(actual.input.unknown, call.input.unknown)
  }
})

test('v2 selector schemas and historical values translate once with permission prompts and references', async () => {
  const tools = [definition('Bash'), { ...definition('Agent'), input_schema: {
    type: 'object', required: ['subagent_type', 'prompt'], additionalProperties: false,
    properties: { subagent_type: { type: 'string', enum: ['Explore', 'claude-code-guide'] }, prompt: { type: 'string' } },
  } }, { ...definition('Skill'), input_schema: { properties: { skill: { type: 'string', enum: ['claude-api', 'anthropic-skills:pdf'] } } } },
  { ...definition('ExitPlanMode'), input_schema: { properties: { allowedPrompts: { type: 'array', items: {
    type: 'object', required: ['tool', 'prompt'], properties: { tool: { const: 'Bash', enum: ['Bash'] }, prompt: { type: 'string' } }, additionalProperties: false,
  } } } } }]
  const calls = [
    { type: 'tool_use', name: 'Agent', input: { subagent_type: 'Explore', prompt: 'literal', nested: { subagent_type: 'Plan' } } },
    { type: 'tool_use', name: 'Skill', input: { skill: 'anthropic-skills:pdf', args: 'claude-api' } },
    { type: 'tool_use', name: 'ExitPlanMode', input: { allowedPrompts: [{ tool: 'Bash', prompt: 'Bash', nested: { tool: 'Bash' } }] } },
  ]
  const { body, codec } = await neutralV2(JSON.stringify({ tools, tool_choice: { type: 'tool', name: 'Agent' }, messages: [
    { role: 'assistant', content: calls },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: [{ type: 'tool_reference', tool_name: 'Bash' }] }] },
  ] }))
  const result = JSON.parse(body.toString())
  assert.equal(result.tool_choice.name, 'delegate')
  assert.deepEqual(result.tools[1].input_schema.properties.agent_type.enum, ['explorer', 'client-guide'])
  assert.deepEqual(result.tools[1].input_schema.required, ['agent_type', 'task'])
  assert.deepEqual(result.tools[2].input_schema.properties.name.enum, ['model-api', 'standard:pdf'])
  assert.deepEqual(result.tools[3].input_schema.properties.permissions.items.properties.tool.enum, ['shell'])
  assert.equal(result.tools[3].input_schema.properties.permissions.items.properties.tool.const, 'shell')
  assert.deepEqual(result.tools[3].input_schema.properties.permissions.items.required, ['tool', 'prompt'])
  assert.deepEqual(result.messages[0].content[0].input, { agent_type: 'explorer', task: 'literal', nested: { subagent_type: 'Plan' } })
  assert.deepEqual(result.messages[0].content[1].input, { name: 'standard:pdf', arguments: 'claude-api' })
  assert.deepEqual(result.messages[0].content[2].input, { permissions: [{ tool: 'shell', prompt: 'Bash', nested: { tool: 'Bash' } }] })
  assert.equal(result.messages[1].content[0].content[0].tool_name, 'shell')
  for (const [index, call] of calls.entries()) assert.deepEqual(codec.translateInput(call.name, result.messages[0].content[index].input, 'decode'), call.input)
})

test('v2 range edits retain raw CLI argument bytes, precision, escaped strings and signatures', async () => {
  const input = '{ "file_path" : "\\u002ftmp/file", "offset":9007199254740993, "limit":1e2, "custom":{"file_path":"literal", "value":9007199254740995, "signature":"\\u0061"} }'
  const agentInput = '{"subagent_type":"Explore","prompt":"\\u0061","nested":{"subagent_type":"Plan","prompt":"keep"}}'
  const opaque = '{"type":"thinking", "thinking":"literal", "signature":"\\u0062"}'
  const text = `{"tools":[${JSON.stringify(definition('Read'))},${JSON.stringify(definition('Agent'))}],"messages":[{"role":"assistant","content":[${opaque},{"type":"tool_use","name":"Read","input":${input}},{"type":"tool_use","name":"Agent","input":${agentInput}}]}],"max_tokens":1e3,"future_number":9007199254740999}`
  const result = (await neutralV2(text)).body.toString()
  assert.ok(result.includes(input.replace('"file_path"', '"path"').replace('"offset"', '"start"').replace('"limit"', '"count"')))
  assert.ok(result.includes(agentInput.replace('"subagent_type":"Explore"', '"agent_type":"explorer"').replace('"prompt"', '"task"')))
  assert.ok(result.includes(opaque))
  assert.ok(result.includes('"max_tokens":1e3,"future_number":9007199254740999'))
})

test('v2 schemas retain required fields, references, dependencies and unknown validation facts', async () => {
  const schema = { type: 'object', required: ['file_path', 'offset'], additionalProperties: false,
    properties: {
      file_path: { type: 'string', minLength: 1, maxLength: 128, pattern: '^/', description: 'Claude Code path.' },
      offset: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
      limit: { type: 'integer', exclusiveMinimum: 0, multipleOf: 2 },
      extension: { type: 'object', required: ['file_path'], properties: { file_path: { enum: ['literal'], const: 'literal' } }, additionalProperties: false, 'x-fact': 'preserve' },
    },
    dependentRequired: { file_path: ['limit'] },
    allOf: [{ properties: { file_path: { $ref: '#/properties/file_path' } } }],
    examples: [{ file_path: 'literal', offset: 2, extension: { file_path: 'nested literal' } }], 'x-custom': { required: ['file_path'], enum: ['Bash'], description: 'Custom metadata.' },
  }
  const { body } = await neutralV2(JSON.stringify({ tools: [{ ...definition('Read'), input_schema: schema }], messages: [] }))
  const actual = JSON.parse(body.toString()).tools[0].input_schema
  assert.deepEqual(actual.required, ['path', 'start'])
  assert.deepEqual(actual.dependentRequired, { path: ['count'] })
  assert.equal(actual.allOf[0].properties.path.$ref, '#/properties/path')
  assert.equal(actual.additionalProperties, false)
  for (const [key, expected] of Object.entries({ minLength: 1, maxLength: 128, pattern: '^/', type: 'string' })) assert.equal(actual.properties.path[key], expected)
  assert.equal(actual.properties.start.minimum, 0)
  assert.equal(actual.properties.start.maximum, 9007199254740991)
  assert.equal(actual.properties.count.exclusiveMinimum, 0)
  assert.equal(actual.properties.count.multipleOf, 2)
  assert.deepEqual(actual.properties.extension, schema.properties.extension)
  assert.deepEqual(actual.examples, [{ path: 'literal', start: 2, extension: { file_path: 'nested literal' } }])
  assert.deepEqual(actual['x-custom'], schema['x-custom'])
})

test('v2 preserves unknown and provider tools, including colliding native-looking names', async () => {
  const unknown = { ...definition('CustomTool'), description: 'Claude Code .claude custom contract', input_schema: { properties: { file_path: { const: 'literal' } } } }
  const provider = { ...definition('Read'), type: 'provider_read_v1' }
  const raw = JSON.stringify({ tools: [unknown, provider], messages: [{ role: 'assistant', content: [{ type: 'tool_use', name: 'CustomTool', input: { file_path: 'literal' } }] }] })
  assert.equal((await neutralV2(raw)).body.toString(), raw)
})

test('v2 fills missing tool descriptions and rejects ambiguous schema or input fields', async () => {
  const raw = '{"tools":[{"name":"Read","input_schema":{"type":"object"}}],"messages":[]}'
  assert.equal(JSON.parse((await neutralV2(raw)).body.toString()).tools[0].description, TOOL_DESCRIPTIONS.Read)
  for (const input of ['{"file_path":"a","file_path":"b"}', '{"file_path":"a","path":"b"}']) {
    await assert.rejects(neutralV2(`{"tools":[${JSON.stringify(definition('Read'))}],"messages":[{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":${input}}]}]}`), error => (error as { status?: number }).status === 400)
  }
  await assert.rejects(neutralV2('{"tools":[{"name":"Read","input_schema":{"properties":{"file_path":{"type":"string","type":"number"}}}}]}'), error => error instanceof BodyError && error.status === 400)
})

for (const [encoding, encode, decode] of [
  ['gzip', gzipSync, gunzipSync], ['deflate', deflateSync, inflateSync],
  ['br', brotliCompressSync, brotliDecompressSync], ['zstd', zstdCompressSync, zstdDecompressSync],
] as const) {
  test(`v2 request rewriting retains ${encoding} transport and bounds`, async () => {
    const raw = JSON.stringify({ tools: [definition('Read')], messages: [{ role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/file' } }] }] })
    const result = await neutralV2(encode(Buffer.from(raw)), '/v1/messages', encoding)
    assert.equal(result.codec.profileId, 'neutral-v2')
    assert.equal(JSON.parse(decode(result.body).toString()).messages[0].content[0].input.path, '/tmp/file')
    assert.deepEqual(decode((await neutralV2(encode(Buffer.from(raw)), '/v1/messages/count_tokens', encoding)).body), decode(result.body))
    const unchanged = encode(Buffer.from('{ "messages": [] }'))
    assert.deepEqual((await neutralV2(unchanged, '/v1/messages', encoding)).body, unchanged)
    await assert.rejects(neutralV2(encode(Buffer.from(' '.repeat(300) + '{}')), '/v1/messages', encoding, 100), error => error instanceof BodyError && error.status === 413)
  })
}

test('v2 compression chains, expanded descriptions and unrelated endpoint handling remain bounded', async () => {
  const raw = JSON.stringify({ tools: [definition('Read')], messages: [] })
  const input = brotliCompressSync(gzipSync(Buffer.from(raw)))
  const result = await neutralV2(input, '/v1/messages', 'gzip, br')
  assert.equal(JSON.parse(gunzipSync(brotliDecompressSync(result.body)).toString()).tools[0].name, 'read_file')
  await assert.rejects(neutralV2(raw, '/v1/messages', undefined, Buffer.byteLength(raw) + 1), error => error instanceof BodyError && error.status === 413)
  const skipped = await neutralV2(raw, '/v1/files')
  assert.equal(skipped.body.toString(), raw)
  assert.equal(skipped.codec.profileId, 'neutral-v2')
})

