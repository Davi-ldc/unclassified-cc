import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PARAMETER_ALIASES } from '../src/parameter-profile.js'
import { curateToolSchema, TOOL_DESCRIPTIONS } from '../src/tool-descriptions.js'
import { createWireCodec, TOOL_ALIASES } from '../src/wire-profile.js'

const tools = Object.keys(TOOL_ALIASES).map(name => ({ name, input_schema: { type: 'object', properties: {} } }))
const branding = /claude|anthropic|\.claude|sonnet|opus|haiku|fable/i

function withoutAnnotations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAnnotations)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description' && key !== 'title').map(([key, child]) => [key, withoutAnnotations(child)]))
}

test('every stock tool has an authored neutral description', () => {
  assert.deepEqual(Object.keys(TOOL_DESCRIPTIONS).sort(), Object.keys(TOOL_ALIASES).sort())
  assert.equal(Object.keys(TOOL_DESCRIPTIONS).length, 23)
  for (const [name, description] of Object.entries(TOOL_DESCRIPTIONS)) {
    assert.ok(description.trim().length > 40, name)
    assert.doesNotMatch(description, branding, name)
    assert.doesNotMatch(description, /[–—]/, name)
  }
})

test('all known root parameters get neutral descriptions without changing validation', () => {
  const codec = createWireCodec({ tools }, 'neutral-v2')
  for (const [name, aliases] of Object.entries(PARAMETER_ALIASES)) {
    const nativeKeys = [...new Set([...Object.keys(aliases), ...(name === 'Agent' ? ['model', 'effort', 'isolation'] : [])])]
    const schema = {
      type: 'object', additionalProperties: false, required: nativeKeys,
      properties: Object.fromEntries(nativeKeys.map(key => [key, {
        type: 'string', enum: ['sample'], const: 'sample',
        ...(name === 'Agent' && key === 'subagent_type' || name === 'Skill' && key === 'skill'
          ? {} : { minLength: 1, maxLength: 512, pattern: '^sample$' }),
        title: 'Native annotation', description: 'Claude Code native parameter description.',
        default: 'literal-default', examples: ['literal-example'], 'x-custom-fact': { keep: true },
      }])),
    }
    const encoded = codec.encodeToolSchema(name, schema)
    const before = structuredClone(encoded)
    const result = curateToolSchema(name, encoded, codec) as typeof schema
    assert.deepEqual(withoutAnnotations(result), withoutAnnotations(encoded), name)
    assert.deepEqual(encoded, before, `${name}: annotation curation must not mutate codec output`)
    for (const key of nativeKeys) {
      const wire = codec.encodeInputKey(name, key)
      const parameter = result.properties[wire]
      assert.ok(parameter.description.trim().length > 0, `${name}.${wire}`)
      assert.doesNotMatch(parameter.description, branding, `${name}.${wire}`)
      assert.equal(parameter.title, wire)
      assert.deepEqual(Object.keys(parameter), Object.keys(parameter).sort())
    }
  }
})

test('curation preserves unknown fields, literal data, nested contracts and boolean schemas', () => {
  const codec = createWireCodec({ tools }, 'neutral-v2')
  const schema = {
    type: 'object', title: 'Native root title', description: 'Native root description',
    required: ['path', 'extension'], additionalProperties: false,
    properties: {
      path: { type: 'string', minLength: 1, description: 'Old path description', 'x-validation': { enabled: true } },
      extension: { description: 'Custom facts must survive.', type: 'object', required: ['value'], properties: { value: { const: 'literal' } }, additionalProperties: false },
      disabled: false,
    },
    dependentRequired: { extension: ['path'] }, $defs: { positive: { type: 'integer', minimum: 1 } },
    allOf: [{ properties: { extension: { $ref: '#/$defs/positive' } } }],
    default: { path: 'literal' }, examples: [{ path: 'another literal' }], 'x-provider': { description: 'Custom metadata.' },
  }
  const result = curateToolSchema('Read', schema, codec) as typeof schema
  assert.equal(result.description, TOOL_DESCRIPTIONS.Read)
  assert.equal(result.title, 'Parameters for read_file')
  assert.deepEqual(withoutAnnotations(result), withoutAnnotations(schema))
  assert.deepEqual(result.properties.extension, schema.properties.extension)
  assert.equal(result.properties.disabled, false)
  assert.deepEqual(result['x-provider'], schema['x-provider'])
  assert.deepEqual(result.examples, schema.examples)
  assert.equal(curateToolSchema('Read', false, codec), false)
  assert.equal(curateToolSchema('Unknown', schema, codec), schema)
})

test('curated operational rules retain consent, delivery and execution boundaries', () => {
  assert.match(TOOL_DESCRIPTIONS.Edit, /before editing or the call fails/)
  assert.match(TOOL_DESCRIPTIONS.Edit, /occur once unless all_matches/)
  assert.match(TOOL_DESCRIPTIONS.NotebookEdit, /exact immutable cell ID/)
  assert.match(TOOL_DESCRIPTIONS.Bash, /environment variables and functions do not/)
  assert.match(TOOL_DESCRIPTIONS.Bash, /user may not see stdout/)
  assert.match(TOOL_DESCRIPTIONS.Bash, /Do not use cat, head, tail, sed, awk or echo unless/)
  assert.match(TOOL_DESCRIPTIONS.Bash, /verified that a dedicated tool cannot do the task/)
  assert.match(TOOL_DESCRIPTIONS.Agent, /do not poll or invent a pending result/)
  assert.match(TOOL_DESCRIPTIONS.EnterWorktree, /explicitly request a worktree/)
  assert.match(TOOL_DESCRIPTIONS.ExitWorktree, /user.*confirmation before retrying/)
  assert.match(TOOL_DESCRIPTIONS.EnterPlanMode, /not approval to execute/)
  assert.match(TOOL_DESCRIPTIONS.AskUserQuestion, /UI adds Other automatically/)
  assert.match(TOOL_DESCRIPTIONS.SendMessage, /Silence is never agreement/)
  assert.match(TOOL_DESCRIPTIONS.SendMessage, /Never ask a peer to perform an action denied/)
  assert.match(TOOL_DESCRIPTIONS.Skill, /Do not guess names/)
  assert.match(TOOL_DESCRIPTIONS.CronCreate, /7 days/)
  assert.match(TOOL_DESCRIPTIONS.CronCreate, /up to 90 seconds early/)
  assert.match(TOOL_DESCRIPTIONS.ScheduleWakeup, /<<autonomous-loop-dynamic>>/)
  assert.match(TOOL_DESCRIPTIONS.Workflow, /explicit user opt-in/)
  assert.match(TOOL_DESCRIPTIONS.Workflow, /literal ultracode keyword/)
  assert.match(TOOL_DESCRIPTIONS.Workflow, /ultracode is enabled for the session/)
  assert.match(TOOL_DESCRIPTIONS.Workflow, /pure literal/)
  assert.match(TOOL_DESCRIPTIONS.ReportFindings, /instructions explicitly request/)
  assert.match(TOOL_DESCRIPTIONS.WebSearch, /URLs actually used/)
})
