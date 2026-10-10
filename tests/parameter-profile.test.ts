import assert from 'node:assert/strict'
import test from 'node:test'
import { PARAMETER_ALIASES } from '../src/parameter-profile.js'
import { createWireCodec, TOOL_ALIASES, WireProfileError } from '../src/wire-profile.js'

const expected: Record<string, Record<string, string>> = {
  Agent: { description: 'label', prompt: 'task', subagent_type: 'agent_type' },
  AskUserQuestion: { questions: 'items', answers: 'responses', annotations: 'notes', metadata: 'context' },
  Bash: { command: 'script', timeout: 'timeout_ms', description: 'label', run_in_background: 'background', dangerouslyDisableSandbox: 'bypass_sandbox' },
  CronCreate: { cron: 'schedule', prompt: 'task', recurring: 'repeat', durable: 'persist' },
  CronDelete: { id: 'job_id' }, CronList: {},
  Edit: { file_path: 'path', old_string: 'search', new_string: 'replacement', replace_all: 'all_matches' },
  EnterPlanMode: {}, EnterWorktree: { name: 'workspace_name', path: 'workspace_path' },
  ExitPlanMode: { allowedPrompts: 'permissions' }, ExitWorktree: { action: 'disposition', discard_changes: 'discard' },
  ListAgents: { channel: 'channel_filter', q: 'search' },
  NotebookEdit: { notebook_path: 'path', cell_id: 'cell', new_source: 'source', cell_type: 'kind', edit_mode: 'operation' },
  Read: { file_path: 'path', offset: 'start', limit: 'count', pages: 'page_range', allow_large: 'allow_oversize' },
  ReportFindings: { level: 'review_level', findings: 'issues' },
  ScheduleWakeup: { delaySeconds: 'delay_seconds', reason: 'reason', prompt: 'task', stop: 'stop', noop: 'unchanged' },
  SendMessage: { to: 'recipient', summary: 'label', message: 'body', notify_when_idle: 'when_idle' },
  Skill: { skill: 'name', args: 'arguments' }, TaskStop: { task_id: 'id', shell_id: 'legacy_shell_id' },
  WebFetch: { url: 'url', prompt: 'instruction', offset: 'start' },
  WebSearch: { query: 'text', allowed_domains: 'include_domains', blocked_domains: 'exclude_domains' },
  Workflow: { script: 'source', name: 'workflow', description: 'description', title: 'title', args: 'input', scriptPath: 'source_path', resumeFromRunId: 'resume_id' },
  Write: { file_path: 'path', content: 'text' },
}
const tools = Object.keys(expected).map(name => ({ name, input_schema: { type: 'object' } }))
const codec = () => createWireCodec({ tools }, 'neutral-v2')
const object = (value: unknown) => value as Record<string, any>
const schema = (name: string, value: unknown) => object(codec().encodeToolSchema(name, value))
const collision = (error: unknown) => error instanceof WireProfileError && error.status === 400 && /collision/i.test(error.message)

function reverseObjects(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjects)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseObjects(entry)]))
}

test('all fixed parameter maps are deeply frozen, invertible, and order independent', () => {
  assert.deepEqual(PARAMETER_ALIASES, expected)
  assert.deepEqual(Object.keys(expected).sort(), Object.keys(TOOL_ALIASES).sort())
  assert.equal(Object.isFrozen(PARAMETER_ALIASES), true)
  const forward = codec()
  const reverse = createWireCodec({ tools: [...tools].reverse() }, 'neutral-v2')
  for (const [tool, aliases] of Object.entries(expected)) {
    assert.equal(Object.isFrozen(PARAMETER_ALIASES[tool]), true)
    assert.equal(forward.needsInputTranslation(tool), Object.keys(aliases).length > 0)
    for (const [native, wire] of Object.entries(aliases)) {
      assert.equal(forward.encodeInputKey(tool, native), wire)
      assert.equal(forward.decodeInputKey(tool, wire), native)
      assert.equal(reverse.encodeInputKey(tool, native), wire)
      assert.equal(reverse.decodeInputKey(tool, wire), native)
    }
    for (const key of ['unknown', '__proto__', 'constructor', 'toString']) {
      assert.equal(forward.encodeInputKey(tool, key), key)
      assert.equal(forward.decodeInputKey(tool, key), key)
    }
  }
  assert.throws(() => Object.assign(PARAMETER_ALIASES.Read, { file_path: 'other' }), TypeError)
})

test('every parameter shape round-trips without touching nested literals', () => {
  const wire = codec()
  const nested = Object.freeze({ file_path: 'literal', command: 'Read file', subagent_type: 'claude', skill: 'claude-api' })
  for (const [tool, aliases] of Object.entries(expected)) {
    const input: Readonly<Record<string, unknown>> = Object.freeze({ ...Object.fromEntries(Object.keys(aliases).map(key => [key, { literal: key, nested }])), unknown: nested })
    const output = wire.translateInput(tool, input, 'encode') as Record<string, unknown>
    for (const [native, alias] of Object.entries(aliases)) assert.equal(output[alias], input[native])
    assert.deepEqual(output, { ...Object.fromEntries(Object.entries(aliases).map(([native, alias]) => [alias, input[native]])), unknown: nested })
    assert.deepEqual(wire.translateInput(tool, output, 'decode'), input)
    assert.equal(output.unknown, nested)
  }
})

test('selector values use native paths before encoding keys and after decoding keys', () => {
  const wire = codec()
  const nested = Object.freeze({ subagent_type: 'claude', skill: 'claude-api', tool: 'Bash' })
  const agent = Object.freeze({ description: 'Claude Code task', prompt: 'Use Bash and Claude Code', subagent_type: 'claude', model: 'opus', effort: 'max', isolation: 'worktree', nested })
  const encoded = wire.translateInput('Agent', agent, 'encode')
  assert.deepEqual(encoded, { label: agent.description, task: agent.prompt, agent_type: 'assistant', model: 'opus', effort: 'max', isolation: 'worktree', nested })
  assert.deepEqual(wire.translateInput('Agent', encoded, 'decode'), agent)
  assert.deepEqual(wire.translateInput('Skill', { skill: 'anthropic-skills:pdf', args: 'Read file_path', nested }, 'encode'), { name: 'standard:pdf', arguments: 'Read file_path', nested })
  const plan = { allowedPrompts: [{ tool: 'Bash', prompt: 'Must ask before modifying permissions', nested }], nested }
  const translated = wire.translateInput('ExitPlanMode', plan, 'encode')
  assert.deepEqual(translated, { permissions: [{ tool: 'shell', prompt: plan.allowedPrompts[0].prompt, nested }], nested })
  assert.deepEqual(wire.translateInput('ExitPlanMode', translated, 'decode'), plan)
  for (const type of ['astra', 'opus', 'fork', 'general-purpose', 'statusline-setup']) {
    assert.deepEqual(wire.translateInput('Agent', { subagent_type: type, model: 'claude-opus-4-6', effort: 'high' }, 'encode'), { agent_type: type, model: 'claude-opus-4-6', effort: 'high' })
  }
})

test('security values and executable payloads are not reinterpreted', () => {
  const wire = codec()
  const command = 'printf "file_path subagent_type Claude Code Bash"'
  for (const bypass of [false, true]) {
    const input = { command, timeout: 123, description: 'Keep safety rules', dangerouslyDisableSandbox: bypass, run_in_background: false }
    const output = wire.translateInput('Bash', input, 'encode')
    assert.deepEqual(output, { script: command, timeout_ms: 123, label: input.description, bypass_sandbox: bypass, background: false })
    assert.deepEqual(wire.translateInput('Bash', output, 'decode'), input)
  }
  assert.deepEqual(wire.translateInput('ExitWorktree', { action: 'keep', discard_changes: false }, 'encode'), { disposition: 'keep', discard: false })
  const code = 'tools.Bash({ command: "Read file_path" });'
  assert.deepEqual(wire.translateInput('Workflow', { script: code, args: { file_path: '/literal', command: code } }, 'encode'), { source: code, input: { file_path: '/literal', command: code } })
})

test('alias collisions fail in either input direction and property order', () => {
  const wire = codec()
  for (const [tool, aliases] of Object.entries(expected)) {
    for (const [native, alias] of Object.entries(aliases)) {
      if (native === alias) continue
      for (const input of [{ [native]: 1, [alias]: 2 }, { [alias]: 2, [native]: 1 }]) {
        assert.throws(() => wire.translateInput(tool, input, 'encode'), collision)
        assert.throws(() => wire.translateInput(tool, input, 'decode'), collision)
      }
    }
  }
})

test('active v2 tools reserve the opposite parameter namespace in both directions', () => {
  const wire = codec()
  for (const [tool, aliases] of Object.entries(expected)) {
    for (const [native, alias] of Object.entries(aliases)) {
      if (native === alias) {
        assert.equal(wire.encodeInputKey(tool, native), native)
        assert.equal(wire.decodeInputKey(tool, alias), alias)
        continue
      }
      assert.throws(() => wire.encodeInputKey(tool, alias), collision)
      assert.throws(() => wire.decodeInputKey(tool, native), collision)
      assert.throws(() => wire.translateInput(tool, { [alias]: 'literal' }, 'encode'), collision)
      assert.throws(() => wire.translateInput(tool, { [native]: 'literal' }, 'decode'), collision)
      assert.throws(() => wire.encodeToolSchema(tool, { properties: { [alias]: { type: 'string' } } }), collision)
    }
  }
  assert.throws(() => wire.translateInput('Read', { path: '/file' }, 'encode'), collision)
  assert.throws(() => wire.translateInput('Read', { file_path: '/file' }, 'decode'), collision)
  assert.throws(() => wire.encodeToolSchema('Read', { properties: { path: { type: 'string' } } }), collision)
  const nested = { path: '/wire-literal', file_path: '/native-literal' }
  assert.deepEqual(wire.translateInput('Read', { file_path: '/file', nested }, 'encode'), { path: '/file', nested })
  assert.deepEqual(wire.translateInput('Read', { path: '/file', nested }, 'decode'), { file_path: '/file', nested })
})

test('provider, unknown, inactive and v1 tools preserve parameter and schema identity', () => {
  const provider = createWireCodec({ tools: [{ name: 'Read', type: 'provider_tool' }, { name: 'custom' }, { name: 'mcp__files__Read' }] }, 'neutral-v2')
  const v1 = createWireCodec({ tools })
  const input = { file_path: '/file', path: '/collision', nested: { tool: 'Bash' } }
  const inputSchema = { type: 'object', properties: { file_path: { type: 'string' }, path: { type: 'string' } }, required: ['file_path'] }
  for (const [wire, names] of [[provider, ['Read', 'custom', 'mcp__files__Read', 'Bash']], [v1, ['Read', 'Bash']]] as const) {
    for (const name of names) {
      assert.equal(wire.encodeInputKey(name, 'file_path'), 'file_path')
      assert.equal(wire.decodeInputKey(name, 'path'), 'path')
      assert.equal(wire.translateInput(name, input, 'encode'), input)
      assert.equal(wire.translateInput(name, input, 'decode'), input)
      assert.equal(wire.encodeToolSchema(name, inputSchema), inputSchema)
    }
  }
  for (const value of [null, false, true, [], 'Read', 42]) assert.equal(codec().translateInput('Read', value, 'encode'), value)
})

test('schemas rename only root keys and retain validation, annotations and unknown extensions', () => {
  const input = {
    $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
    minProperties: 1, maxProperties: 5, description: 'Use Read only with approval. Never change permissions.',
    properties: {
      offset: { type: 'integer', minimum: 0, maximum: 100, default: 0, multipleOf: 1 },
      file_path: { type: 'string', minLength: 1, maxLength: 400, pattern: '^/', format: 'path', description: 'Use Bash only with approval.' },
      metadata: { type: 'object', properties: { file_path: { const: 'Read' }, offset: { enum: ['Bash', 'Claude Code'] } }, required: ['file_path'], additionalProperties: true },
    },
    required: ['offset', 'file_path'], 'x-contract': { offset: 'literal', description: 'Read stays literal here' },
  }
  const snapshot = JSON.stringify(input)
  const output = schema('Read', input)
  assert.deepEqual(output.required, ['path', 'start'])
  assert.deepEqual(Object.keys(output.properties), ['metadata', 'path', 'start'])
  assert.deepEqual(output.properties.start, input.properties.offset)
  assert.equal(output.properties.path.pattern, '^/')
  assert.equal(output.properties.path.minLength, 1)
  assert.equal(output.properties.path.maxLength, 400)
  assert.equal(output.properties.path.format, 'path')
  assert.equal(output.properties.path.description, 'Use shell only with approval.')
  assert.equal(output.description, 'Use read_file only with approval. Never change permissions.')
  assert.deepEqual(output.properties.metadata, input.properties.metadata)
  assert.deepEqual(output['x-contract'], input['x-contract'])
  assert.equal(output.$schema, input.$schema)
  assert.equal(output.additionalProperties, false)
  assert.equal(output.minProperties, 1)
  assert.equal(output.maxProperties, 5)
  assert.equal(JSON.stringify(input), snapshot)
  assert.equal(JSON.stringify(output), JSON.stringify(schema('Read', reverseObjects(input))))
})

test('schema selector enum and const keep native semantic paths through renamed keys', () => {
  const agent = schema('Agent', {
    type: 'object', required: ['subagent_type'],
    properties: {
      subagent_type: { anyOf: [{ enum: ['claude', 'Plan', 'astra', 'opus', 'fork'] }, { const: 'Explore' }], default: 'claude' },
      model: { enum: ['opus', 'claude-opus-4-6'], default: 'opus' }, effort: { enum: ['low', 'max'] }, isolation: { const: 'worktree' },
      prompt: { enum: ['Use Claude Code and Bash'], default: 'Read file_path' },
      nested: { properties: { subagent_type: { enum: ['claude'] } } },
    },
  })
  assert.deepEqual(agent.properties.agent_type.anyOf, [{ enum: ['assistant', 'planner', 'astra', 'opus', 'fork'] }, { const: 'explorer' }])
  assert.equal(agent.properties.agent_type.default, 'assistant')
  assert.deepEqual(agent.required, ['agent_type'])
  assert.deepEqual(agent.properties.model, { enum: ['opus', 'claude-opus-4-6'], default: 'opus' })
  assert.deepEqual(agent.properties.effort.enum, ['low', 'max'])
  assert.equal(agent.properties.isolation.const, 'worktree')
  assert.deepEqual(agent.properties.task, { enum: ['Use Claude Code and Bash'], default: 'Read file_path' })
  assert.deepEqual(agent.properties.nested, { properties: { subagent_type: { enum: ['claude'] } } })
  assert.deepEqual(schema('Skill', { properties: { skill: { enum: ['claude-api', 'anthropic-skills:pdf', 'humanizer'] } } }).properties.name.enum, ['model-api', 'standard:pdf', 'humanizer'])
  const plan = schema('ExitPlanMode', { properties: { allowedPrompts: { type: 'array', items: { type: 'object', required: ['tool', 'prompt'], properties: { tool: { enum: ['Bash', 'Read'] }, prompt: { const: 'Bash must not bypass approvals' } } } } } })
  assert.deepEqual(plan.properties.permissions.items.properties.tool.enum, ['shell', 'read_file'])
  assert.equal(plan.properties.permissions.items.properties.prompt.const, 'Bash must not bypass approvals')
  assert.deepEqual(plan.properties.permissions.items.required, ['tool', 'prompt'])
})

test('dependencies and same-instance schema branches rename root references consistently', () => {
  const output = schema('Read', {
    properties: { file_path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } },
    dependentRequired: { offset: ['file_path', 'limit'] },
    dependencies: { file_path: ['offset'], limit: { required: ['file_path'], properties: { offset: { minimum: 1 } } } },
    dependentSchemas: { offset: { required: ['limit'], properties: { limit: { minimum: 1 } } } },
    propertyNames: { anyOf: [{ enum: ['file_path', 'offset'] }, { const: 'limit' }] },
    allOf: [{ required: ['file_path'] }], anyOf: [{ required: ['offset'] }], oneOf: [{ required: ['limit'] }],
    if: { required: ['offset'] }, then: { required: ['limit'] }, else: { not: { required: ['limit'] } },
  })
  assert.deepEqual(output.dependentRequired, { start: ['count', 'path'] })
  assert.deepEqual(output.dependencies, { path: ['start'], count: { required: ['path'], properties: { start: { minimum: 1 } } } })
  assert.deepEqual(output.dependentSchemas, { start: { required: ['count'], properties: { count: { minimum: 1 } } } })
  assert.deepEqual(output.propertyNames, { anyOf: [{ enum: ['path', 'start'] }, { const: 'count' }] })
  assert.deepEqual(output.allOf, [{ required: ['path'] }])
  assert.deepEqual(output.anyOf, [{ required: ['start'] }])
  assert.deepEqual(output.oneOf, [{ required: ['count'] }])
  assert.deepEqual(output.if, { required: ['start'] })
  assert.deepEqual(output.then, { required: ['count'] })
  assert.deepEqual(output.else, { not: { required: ['count'] } })
})

test('local references rename their target paths, including root definitions and escaped pointers', () => {
  const input = {
    $ref: '#/$defs/Input',
    $defs: { Input: { type: 'object', properties: { file_path: { type: 'string' }, 'a/b~c %': { type: 'string' }, offset: { $ref: '#/$defs/Input/properties/file_path' }, extra: { $ref: '#/$defs/Input/properties/a~1b~0c%20%25' } }, required: ['file_path'] } },
  }
  const output = schema('Read', input)
  assert.equal(output.$ref, '#/$defs/Input')
  assert.deepEqual(output.$defs.Input.required, ['path'])
  assert.equal(output.$defs.Input.properties.start.$ref, '#/$defs/Input/properties/path')
  assert.equal(output.$defs.Input.properties.extra.$ref, '#/$defs/Input/properties/a~1b~0c%20%25')
  assert.equal(JSON.stringify(output), JSON.stringify(schema('Read', reverseObjects(input))))
  const selector = schema('Agent', { properties: { subagent_type: { $ref: '#/definitions/Kind' } }, definitions: { Kind: { enum: ['claude', 'Plan'] } } })
  assert.equal(selector.properties.agent_type.$ref, '#/definitions/Kind')
  assert.deepEqual(selector.definitions.Kind.enum, ['assistant', 'planner'])
  assert.throws(() => schema('ExitPlanMode', { properties: { allowedPrompts: { items: { properties: { tool: { enum: ['Bash'] } } } }, alias: { $ref: '#/properties/allowedPrompts/items/properties/tool' } } }), /Conflicting schema reference/)
})

test('schema root literals preserve constraints while translating their parameter shapes', () => {
  const literal = { subagent_type: 'claude', prompt: 'Use Bash', model: 'opus', nested: { subagent_type: 'claude' } }
  const translated = { agent_type: 'assistant', task: 'Use Bash', model: 'opus', nested: { subagent_type: 'claude' } }
  const output = schema('Agent', { enum: [literal], const: literal, default: literal, examples: [literal] })
  assert.deepEqual(output.enum, [translated])
  assert.deepEqual(output.const, translated)
  assert.deepEqual(output.default, translated)
  assert.deepEqual(output.examples, [translated])
})

test('schema collisions and unsupported validation constructs fail explicitly', () => {
  for (const input of [
    { properties: { file_path: {}, path: {} } },
    { required: ['file_path', 'path'] },
    { dependentRequired: { file_path: [], path: [] } },
    { dependencies: { file_path: ['offset', 'start'] } },
    { allOf: [{ properties: { file_path: {} } }, { properties: { path: {} } }] },
    { propertyNames: { enum: ['file_path', 'path'] } },
  ]) assert.throws(() => schema('Read', input), collision)
  for (const input of [
    { patternProperties: { '^file_': { type: 'string' } } },
    { propertyNames: { pattern: '^file_' } },
    { propertyNames: { minLength: 8 } },
    { $dynamicRef: '#node' }, { $recursiveRef: '#' }, { $ref: 'https://example.test/root.json' },
    { $ref: '#/missing' }, { $ref: '#/%' }, { $ref: '#/bad~2pointer' }, { $ref: '#anchor' },
    { $ref: '#/x-root', 'x-root': { properties: { file_path: {} } } },
    { properties: { file_path: { $id: 'nested.json', type: 'string' } } },
    { $ref: '#/$defs/Shared', $defs: { Shared: { properties: { file_path: { $ref: '#/$defs/Shared' } } } } },
  ]) assert.throws(() => schema('Read', input), error => error instanceof WireProfileError && error.status === 400)
  assert.throws(() => schema('Agent', { properties: { subagent_type: { $ref: '#/$defs/Kind' }, prompt: { $ref: '#/$defs/Kind' } }, $defs: { Kind: { enum: ['claude'] } } }), /Conflicting schema reference/)
  assert.throws(() => schema('Agent', { properties: { subagent_type: { anyOf: [{ const: 'assistant' }] } } }), collision)
})
