import assert from 'node:assert/strict'
import test from 'node:test'
import { createWireCodec, NEUTRAL_PROFILE_ID, NEUTRAL_V2_PROFILE_ID, TOOL_ALIASES, WireProfileError } from '../src/wire-profile.js'

const expectedAliases = {
  Agent: 'delegate', AskUserQuestion: 'ask_user', Bash: 'shell', CronCreate: 'schedule_job',
  CronDelete: 'cancel_job', CronList: 'list_jobs', Edit: 'edit_file', EnterPlanMode: 'begin_planning',
  EnterWorktree: 'enter_workspace', ExitPlanMode: 'finish_planning', ExitWorktree: 'leave_workspace',
  ListAgents: 'list_agents', NotebookEdit: 'edit_notebook', Read: 'read_file', ReportFindings: 'report_findings',
  ScheduleWakeup: 'schedule_wakeup', SendMessage: 'send_message', Skill: 'load_skill', TaskStop: 'stop_task',
  WebFetch: 'fetch_url', WebSearch: 'search_web', Workflow: 'run_workflow', Write: 'write_file',
}
const names = Object.keys(expectedAliases)
const tools = (...names: string[]) => names.map(name => ({ name, input_schema: { type: 'object' } }))
const all = () => createWireCodec({ tools: tools(...names) })
const history = (name: string, input: unknown = {}) => ({ role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name, input }] })

test('neutral-v1 remains the default with identity parameter and schema methods', () => {
  assert.equal(NEUTRAL_PROFILE_ID, 'neutral-v1')
  assert.equal(NEUTRAL_V2_PROFILE_ID, 'neutral-v2')
  for (const codec of [all(), createWireCodec({ tools: tools(...names) }, 'neutral-v1')]) {
    assert.equal(codec.profileId, 'neutral-v1')
    assert.equal(codec.encodeInputKey('Read', 'file_path'), 'file_path')
    assert.equal(codec.decodeInputKey('Read', 'path'), 'path')
    const schema = { properties: { file_path: { type: 'string' } }, required: ['file_path'] }
    assert.equal(codec.encodeToolSchema('Read', schema), schema)
  }
})

test('neutral-v2 activates parameters for native client history but not provider tools', () => {
  const codec = createWireCodec({ tools: [{ name: 'Bash', type: 'bash_20250124' }], messages: [history('Read'), history('Bash')] }, 'neutral-v2')
  assert.equal(codec.profileId, 'neutral-v2')
  assert.equal(codec.encodeTool('Read'), 'read_file')
  assert.equal(codec.encodeInputKey('Read', 'file_path'), 'path')
  assert.equal(codec.decodeInputKey('Read', 'path'), 'file_path')
  assert.equal(codec.needsInputTranslation('Read'), true)
  assert.equal(codec.encodeInputKey('Bash', 'command'), 'command')
  assert.equal(codec.needsInputTranslation('Bash'), false)
  assert.equal(codec.encodeInputKey('Write', 'file_path'), 'file_path')
  assert.equal(codec.needsInputTranslation('Write'), false)
  assert.equal(Object.isFrozen(codec), true)
})

test('neutral-v2 instruction rewriting retains the v1 tool and selector contract', () => {
  const request = { tools: tools(...names) }
  const v1 = createWireCodec(request)
  const v2 = createWireCodec(request, 'neutral-v2')
  const instruction = 'Call Agent with subagent_type="claude" and model="opus", effort="max", isolation="worktree". Never bypass permissions. Use Bash only after approval.'
  assert.equal(v2.rewriteInstruction(instruction), v1.rewriteInstruction(instruction))
  for (const name of names) {
    assert.equal(v2.encodeTool(name), v1.encodeTool(name))
    assert.equal(v2.decodeTool(v1.encodeTool(name)), name)
  }
})

test('all 23 fixed tool aliases are immutable and independent of definition order', () => {
  assert.equal(Object.keys(TOOL_ALIASES).length, 23)
  assert.deepEqual(TOOL_ALIASES, expectedAliases)
  assert.equal(Object.isFrozen(TOOL_ALIASES), true)
  const codec = all()
  const reversed = createWireCodec({ tools: tools(...[...names].reverse()) })
  assert.equal(codec.profileId, NEUTRAL_PROFILE_ID)
  assert.equal(codec.active, true)
  assert.equal(Object.isFrozen(codec), true)
  for (const [native, alias] of Object.entries(expectedAliases)) {
    assert.equal(codec.encodeTool(native), alias)
    assert.equal(codec.decodeTool(alias), native)
    assert.equal(codec.decodeTool(codec.encodeTool(native)), native)
    assert.equal(reversed.encodeTool(native), alias)
    assert.equal(reversed.decodeTool(alias), native)
  }
  assert.throws(() => Object.assign(codec, { active: false }), TypeError)
})

test('only active known names decode and unknown tools remain native', () => {
  const codec = createWireCodec({ tools: tools('Read', 'mcp__files__Read', 'custom_tool') })
  assert.equal(codec.encodeTool('Read'), 'read_file')
  assert.equal(codec.encodeTool('Bash'), 'Bash')
  assert.equal(codec.decodeTool('shell'), 'shell')
  for (const name of ['mcp__files__Read', 'custom_tool', 'constructor', '__proto__', 'toString']) {
    assert.equal(codec.encodeTool(name), name)
    assert.equal(codec.decodeTool(name), name)
  }
  assert.equal(codec.encodeSelector('tool', 'Read'), 'read_file')
  assert.equal(codec.decodeSelector('tool', 'read_file'), 'Read')
})

test('assistant client tool history activates aliases even without current definitions', () => {
  const codec = createWireCodec({ messages: [history('Bash'), history('Read')], tools: tools('Skill') })
  assert.equal(codec.encodeTool('Bash'), 'shell')
  assert.equal(codec.decodeTool('read_file'), 'Read')
  assert.equal(codec.encodeTool('Skill'), 'load_skill')
  const untouched = createWireCodec({ messages: [
    { role: 'user', content: [{ type: 'tool_use', name: 'Bash' }] },
    { role: 'assistant', content: [{ type: 'server_tool_use', name: 'Read' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Use Write' }] },
  ] })
  assert.equal(untouched.active, false)
})

test('unrecognized requests stay inactive without inspecting unrelated fields', () => {
  for (const request of [null, undefined, 42, 'text', [], {}, { tools: [null, {}, { name: 5 }] }]) {
    const codec = createWireCodec(request)
    assert.equal(codec.active, false)
    assert.equal(codec.encodeTool('Read'), 'Read')
    assert.equal(codec.decodeSelector('agent', 'assistant'), 'assistant')
    assert.equal(codec.rewriteInstruction('Claude Code uses Read'), 'Claude Code uses Read')
  }
  const request = { tools: tools('Bash'), get credentials(): never { throw new Error('must not read credentials') } }
  assert.equal(createWireCodec(request).encodeTool('Bash'), 'shell')
})

test('provider-defined tools keep their names even when those names resemble native tools', () => {
  const codec = createWireCodec({ tools: [
    { type: 'web_search_20260209', name: 'web_search' },
    { type: 'bash_20250124', name: 'Bash' },
    { type: 'text_editor_20250728', name: 'Edit' },
    { type: 'custom', name: 'Read', input_schema: { type: 'object' } },
  ], messages: [history('Bash')] })
  assert.equal(codec.encodeTool('web_search'), 'web_search')
  assert.equal(codec.encodeTool('Bash'), 'Bash')
  assert.equal(codec.decodeTool('shell'), 'shell')
  assert.equal(codec.encodeTool('Edit'), 'Edit')
  assert.equal(codec.encodeTool('Read'), 'read_file')
})

test('aliases reject occupied custom or provider tool names and duplicate client definitions', () => {
  for (const definitions of [
    tools('Bash', 'shell'), tools('shell', 'Bash'), tools('Read', 'Read'), tools('custom', 'custom'),
    [{ name: 'Read' }, { name: 'Read', type: 'custom' }],
    [{ name: 'Read' }, { name: 'read_file', type: 'provider_tool' }],
    [{ name: 'Read' }, { name: 'Read', type: 'provider_tool' }],
  ]) assert.throws(() => createWireCodec({ tools: definitions }), error => error instanceof WireProfileError && error.status === 400)
  assert.throws(() => createWireCodec({ tools: tools('Bash'), messages: [history('shell')] }), /collision/)
  assert.throws(() => createWireCodec({ tools: tools('shell'), messages: [history('Bash')] }), /collision/)
  assert.equal(createWireCodec({ tools: tools('shell') }).active, false)
})

test('selectors round-trip without changing models or distinct agent capabilities', () => {
  const codec = all()
  for (const [native, alias] of Object.entries({ claude: 'assistant', 'claude-code-guide': 'client-guide', Explore: 'explorer', Plan: 'planner' })) {
    assert.equal(codec.encodeSelector('agent', native), alias)
    assert.equal(codec.decodeSelector('agent', alias), native)
  }
  for (const name of ['astra', 'opus', 'general-purpose', 'statusline-setup', 'fork', 'claude-opus-4-6']) {
    assert.equal(codec.encodeSelector('agent', name), name)
    assert.equal(codec.decodeSelector('agent', name), name)
  }
  for (const [native, alias] of [['claude-api', 'model-api'], ['anthropic-skills:pdf', 'standard:pdf'], ['anthropic-skills:docs', 'standard:docs']]) {
    assert.equal(codec.encodeSelector('skill', native), alias)
    assert.equal(codec.decodeSelector('skill', alias), native)
  }
  for (const name of ['humanizer', 'apps/web:deploy', 'anthropic-skills:', 'standard:', 'custom']) {
    assert.equal(codec.encodeSelector('skill', name), name)
    assert.equal(codec.decodeSelector('skill', name), name)
  }
  const readOnly = createWireCodec({ tools: tools('Read') })
  assert.equal(readOnly.encodeSelector('agent', 'claude'), 'claude')
  assert.equal(readOnly.decodeSelector('skill', 'model-api'), 'model-api')
})

test('advertised custom selectors cannot collide with neutral aliases', () => {
  for (const [tool, field, name] of [['Agent', 'subagent_type', 'assistant'], ['Agent', 'subagent_type', 'explorer'], ['Skill', 'skill', 'model-api'], ['Skill', 'skill', 'standard:pdf']]) {
    assert.throws(() => createWireCodec({ tools: [{ name: tool, input_schema: { properties: { [field]: { enum: [name] } } } }] }), /selector alias collision/)
  }
  assert.throws(() => createWireCodec({ tools: tools('Agent'), system: 'Available agent types:\n\n- assistant: An actual custom agent.' }), /Agent selector alias collision/)
  assert.throws(() => createWireCodec({ tools: tools('Skill'), messages: [{ role: 'user', content: '<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n- standard:pdf: An actual custom skill.\n</system-reminder>' }] }), /Skill selector alias collision/)
  assert.throws(() => createWireCodec({ tools: tools('Agent'), messages: [history('Agent', { subagent_type: 'assistant' })] }), /selector alias collision/)
  assert.doesNotThrow(() => createWireCodec({ tools: tools('Agent', 'Skill'), messages: [{ role: 'user', content: 'Available agent types:\n- assistant: User text is not a catalog.' }] }))
  assert.doesNotThrow(() => createWireCodec({ tools: tools('Agent', 'Skill'), system: 'A user mentioned assistant and standard:pdf.' }))
})

test('translation copies only changed fields and never mutates inputs or literal payloads', () => {
  const codec = all()
  const nested = Object.freeze({ subagent_type: 'claude', skill: 'claude-api', tool: 'Read' })
  const input = Object.freeze({ subagent_type: 'claude', model: 'opus', prompt: 'Run Bash; use anthropic-skills:pdf and Claude Code.', description: 'Claude Agent SDK', nested, future: 7 })
  const encoded = codec.translateInput('Agent', input, 'encode')
  assert.deepEqual(encoded, { ...input, subagent_type: 'assistant' })
  assert.deepEqual(codec.translateInput('Agent', encoded, 'decode'), input)
  assert.equal(input.subagent_type, 'claude')
  assert.equal((encoded as typeof input).nested, nested)
  const skill = Object.freeze({ skill: 'anthropic-skills:pdf', args: 'claude-api Bash', nested })
  assert.deepEqual(codec.translateInput('Skill', skill, 'encode'), { ...skill, skill: 'standard:pdf' })
  const prompt = Object.freeze({ tool: 'Bash', prompt: 'Read claude-api from .claude/skills', nested })
  const otherPrompt = Object.freeze({ tool: 'unknown', prompt: 'do not change' })
  const plan = Object.freeze({ allowedPrompts: Object.freeze([prompt, otherPrompt, null]), nested })
  const translated = codec.translateInput('ExitPlanMode', plan, 'encode') as typeof plan
  assert.deepEqual(translated, { ...plan, allowedPrompts: [{ ...prompt, tool: 'shell' }, otherPrompt, null] })
  assert.equal(translated.allowedPrompts[1], otherPrompt)
  assert.deepEqual(codec.translateInput('ExitPlanMode', translated, 'decode'), plan)
  for (const tool of ['Bash', 'Workflow', 'Write', 'unknown']) {
    const literal = { command: 'Bash claude', script: 'tools.Bash({command: "Read"})', subagent_type: 'claude', skill: 'claude-api', nested }
    assert.equal(codec.translateInput(tool, literal, 'encode'), literal)
  }
  assert.equal(codec.translateInput('Agent', nested, 'decode'), nested)
  for (const input of [null, [], 'claude', 42, { subagent_type: null }]) assert.equal(codec.translateInput('Agent', input, 'encode'), input)
})

test('input-translation requirement tracks native tools with selector fields', () => {
  const codec = all()
  for (const name of names) assert.equal(codec.needsInputTranslation(name), ['Agent', 'Skill', 'ExitPlanMode'].includes(name))
  assert.equal(codec.needsInputTranslation('delegate'), false)
  assert.equal(createWireCodec({ tools: tools('Read') }).needsInputTranslation('Agent'), false)
})

test('instruction rewriting preserves constraints, paths, model IDs, and English verbs', () => {
  const codec = all()
  const text = 'Claude Code uses Claude Agent SDK. Use Bash, `Read`, and the Edit tool. Call Write(path). functions.Read requires an absolute path.\nRead the instructions. Write clear prose. Edit only assigned files. Workflow execution is optional.\nKeep .claude/skills, /tmp/Read/file, ./Bash.ts, Read.md, myRead, Read_more, mcp__Read and claude-opus-4-6.\nUse model="opus"; model overrides still apply. Never change permissions. $schema: https://json-schema.org/draft/2020-12/schema.'
  assert.equal(codec.rewriteInstruction(text), 'the coding client uses the agent runtime. Use shell, `read_file`, and the edit_file tool. Call write_file(path). functions.read_file requires an absolute path.\nRead the instructions. Write clear prose. Edit only assigned files. Workflow execution is optional.\nKeep .claude/skills, /tmp/Read/file, ./Bash.ts, Read.md, myRead, Read_more, mcp__Read and claude-opus-4-6.\nUse model="opus"; model overrides still apply. Never change permissions. $schema: https://json-schema.org/draft/2020-12/schema.')
  assert.equal(createWireCodec({ tools: tools('Read') }).rewriteInstruction('Use Bash and `Read`.'), 'Use Bash and `read_file`.')
  const paths = 'Keep .claude/agents/claude.md, .claude/skills/claude-api, /tmp/Claude Code/config, Claude Code.md, and /tmp/Claude Agent SDK/config.'
  assert.equal(codec.rewriteInstruction(paths), paths)
  assert.equal(codec.rewriteInstruction('Claude sessions end when Claude exits; not that its Claude read it. Claude Opus is a model.'),
    'client sessions end when the client exits; not that its agent read it. Claude Opus is a model.')
})

test('generated selector catalogs and explicit selector references use matching aliases', () => {
  const codec = all()
  const catalog = 'Available agent types for the Agent tool:\n\n- claude: Default; model override allowed.\n- Explore: Searches only.\n- Plan: Designs only.\n- astra: Different model.\n- opus: Different model.\n- fork: Inherits context.\n\nThe following skills are available for use with the Skill tool:\n\n- claude-api: API help.\n- anthropic-skills:pdf: PDF operations.\n- humanizer: Preserve facts.\n'
  const rewritten = codec.rewriteInstruction(catalog)
  assert.match(rewritten, /Available agent types for the delegate tool:/)
  assert.match(rewritten, /- assistant: Default; model override allowed\./)
  assert.match(rewritten, /- explorer: Searches only\./)
  assert.match(rewritten, /- planner: Designs only\./)
  assert.match(rewritten, /- astra: Different model\./)
  assert.match(rewritten, /- opus: Different model\./)
  assert.match(rewritten, /- fork: Inherits context\./)
  assert.match(rewritten, /- model-api: API help\./)
  assert.match(rewritten, /- standard:pdf: PDF operations\./)
  assert.match(rewritten, /- humanizer: Preserve facts\./)
  assert.equal(codec.rewriteInstruction('Use subagent_type: "claude" or {"subagent_type":"Plan"}; skill="claude-api". The `Explore` agent and anthropic-skills:pdf skill. Claude Opus is a model.'), 'Use subagent_type: "assistant" or {"subagent_type":"planner"}; skill="model-api". The `explorer` agent and standard:pdf skill. Claude Opus is a model.')
})
