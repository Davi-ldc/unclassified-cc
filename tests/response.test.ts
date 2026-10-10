import assert from 'node:assert/strict'
import { Readable, Writable, type Transform } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import { test } from 'node:test'
import { createResponseTransform, restoreJsonResponse } from '../src/response.js'
import { createWireCodec } from '../src/wire-profile.js'
import { PARAMETER_ALIASES } from '../src/parameter-profile.js'

const codec = createWireCodec({
  tools: ['Agent', 'Skill', 'ExitPlanMode', 'Write', 'Read', 'Edit', 'Bash'].map(name => ({ name, input_schema: { type: 'object' } })),
  messages: [],
})
const v2 = createWireCodec({
  tools: Object.entries(PARAMETER_ALIASES).map(([name, aliases]) => ({
    name, input_schema: { type: 'object', properties: Object.fromEntries(Object.keys(aliases).map(key => [key, {}])) },
  })),
  messages: [],
}, 'neutral-v2')
const OPTIONS = { timeout: 8_000 }

async function restore(chunks: Buffer[], mode: 'sse' | 'json' = 'sse', requestCodec = codec, maxBytes?: number): Promise<Buffer> {
  const output: Buffer[] = []
  await pipeline(Readable.from(chunks), createResponseTransform(requestCodec, mode, maxBytes), new Writable({
    write(chunk: Buffer, _encoding, callback) { output.push(Buffer.from(chunk)); callback() },
  }))
  return Buffer.concat(output)
}

function event(type: string, fields: Record<string, unknown> = {}, ending = '\n'): string {
  return `event: ${type}${ending}data: ${JSON.stringify({ type, ...fields })}${ending}${ending}`
}
function start(index: number, nativeTool: string, input: unknown = {}, ending = '\n', requestCodec = codec): string {
  return event('content_block_start', { index, content_block: { type: 'tool_use', id: `tool-${index}`, name: requestCodec.encodeTool(nativeTool), input } }, ending)
}
function startV2(index: number, nativeTool: string, input: unknown = {}): string {
  return start(index, nativeTool, input, '\n', v2)
}
function delta(index: number, partial: string, ending = '\n'): string {
  return event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: partial } }, ending)
}
function stop(index: number): string { return event('content_block_stop', { index }) }
function events(text: string): any[] {
  return text.split(/\r?\n\r?\n/).flatMap(raw => {
    const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
    return data ? [JSON.parse(data)] : []
  })
}
function inputOf(text: string, index: number): string {
  return events(text).filter(item => item.type === 'content_block_delta' && item.index === index && item.delta.type === 'input_json_delta')
    .map(item => item.delta.partial_json).join('')
}
function write(stream: Transform, text: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => stream.write(text, error => error ? reject(error) : resolve()))
}

test('JSON response range edits preserve signatures, IDs, whitespace, and numeric lexemes', OPTIONS, async () => {
  const source = `{
  "id": 9223372036854775807, "usage": {"input_tokens": 9007199254740993, "fraction": 1.2300e+40},
  "content": [
    {"type":"thinking","thinking":"delegate assistant model-api","signature":"signed\\/value\\u0061"},
    {"type":"tool_use","id":"delegate","name":"delegate","input":{"subagent_type":"ass\\u0069stant","prompt":"assistant delegate","nested":{"subagent_type":"assistant"},"number":-0}},
    {"type":"tool_use","name":"load_skill","input":{"skill":"standard:pdf","args":"standard:pdf model-api"}},
    {"type":"tool_use","name":"finish_planning","input":{"allowedPrompts":[{"tool":"shell","prompt":"shell"}],"tool":"shell"}},
    {"type":"server_tool_use","name":"delegate","input":{"subagent_type":"assistant"}},
    {"type":"future","name":"load_skill","input":{"skill":"model-api"}}
  ], "extra": {"name":"delegate"}, "stop_reason":"tool_use"
}`
  const expected = source.replace('"name":"delegate","input":{"subagent_type":"ass\\u0069stant"', '"name":"Agent","input":{"subagent_type":"claude"')
    .replace('"name":"load_skill","input":{"skill":"standard:pdf"', '"name":"Skill","input":{"skill":"anthropic-skills:pdf"')
    .replace('"name":"finish_planning"', '"name":"ExitPlanMode"')
    .replace('"allowedPrompts":[{"tool":"shell"', '"allowedPrompts":[{"tool":"Bash"')
  assert.equal(restoreJsonResponse(Buffer.from(source), codec).toString(), expected)
  assert.equal((await restore([Buffer.from(source)], 'json')).toString(), expected)
})

test('JSON errors, unknown calls, and an inactive request codec pass unchanged', OPTIONS, async () => {
  for (const source of [
    '{"type":"error","error":{"message":"delegate assistant"},"n":9223372036854775807}',
    '{"content":[{"type":"tool_use","name":"custom","input":{"skill":"model-api"}}]}',
    '{"content":[{"type":"text","text":"load_skill"}]}',
    'not JSON',
  ]) {
    const raw = Buffer.from(source)
    assert.strictEqual(restoreJsonResponse(raw, codec), raw)
    assert.deepEqual(await restore([raw], 'json'), raw)
  }
  const inactive = createWireCodec({ tools: [] })
  const raw = Buffer.from(start(0, 'Agent') + delta(0, '{invalid'))
  assert.deepEqual(await restore([raw], 'sse', inactive), raw)
})

test('actual codec aliases round-trip response calls and selectors for replay', OPTIONS, () => {
  const calls = [
    { name: 'Agent', input: { subagent_type: 'claude-code-guide', prompt: 'client-guide delegate' } },
    { name: 'Agent', input: { subagent_type: 'Explore', prompt: 'explorer' } },
    { name: 'Skill', input: { skill: 'claude-api', args: 'model-api' } },
    { name: 'Skill', input: { skill: 'anthropic-skills:docs', args: 'standard:docs' } },
    { name: 'ExitPlanMode', input: { allowedPrompts: [{ tool: 'Bash', prompt: 'shell' }, { tool: 'Read', prompt: 'read_file' }] } },
    { name: 'Write', input: { content: 'delegate assistant', file_path: 'model-api' } },
    { name: 'Edit', input: { old_string: 'shell', new_string: 'delegate' } },
  ]
  const wire = { content: calls.map((call, index) => ({
    type: 'tool_use', id: `id-${index}`, name: codec.encodeTool(call.name), input: codec.translateInput(call.name, call.input, 'encode'),
  })) }
  const restored = JSON.parse(restoreJsonResponse(Buffer.from(JSON.stringify(wire)), codec).toString())
  assert.deepEqual(restored.content.map(({ name, input }: any) => ({ name, input })), calls)
  const replay = restored.content.map((call: any) => ({ ...call, name: codec.encodeTool(call.name), input: codec.translateInput(call.name, call.input, 'encode') }))
  assert.deepEqual(replay, wire.content)
})

test('SSE handles every byte split across UTF-8 and mixed LF/CRLF delimiters', OPTIONS, async () => {
  const source = Buffer.from(': comentário café\r\n\r\n' + start(0, 'Skill', { skill: 'model-api', args: 'ação 漢字' }, '\r\n')
    + stop(0) + event('message_stop'))
  const expected = source.toString().replace('"name":"load_skill"', '"name":"Skill"').replace('"skill":"model-api"', '"skill":"claude-api"')
  for (let index = 0; index <= source.length; index++) {
    const result = await restore([source.subarray(0, index), source.subarray(index)])
    assert.equal(result.toString(), expected, `split at byte ${index}`)
  }
  assert.equal((await restore([...source].map(byte => Buffer.from([byte])))).toString(), expected)
})

test('multiline SSE data edits only JSON string ranges and keeps comments and fields', OPTIONS, async () => {
  const source = ': keep\r\nid: 9223372036854775807\r\nevent: content_block_start\n'
    + 'data: {"type":"content_block_start",\r\nretry: 007\r\n'
    + 'data:\t"index":4,"content_block":{"type":"tool_use","name":"delegate",\n'
    + 'x-extra: delegate\ndata: "input":{"subagent_type":"planner","prompt":"planner"},"id":"delegate"}}\r\n\r\n'
    + stop(4)
  const expected = source.replace('"name":"delegate"', '"name":"Agent"').replace('"subagent_type":"planner"', '"subagent_type":"Plan"')
  assert.equal((await restore([Buffer.from(source)])).toString(), expected)
})

test('interleaved selector inputs keep event ordering, indices, and unrelated events exact', OPTIONS, async () => {
  const ping = ': unchanged\r\nevent: ping\r\nx-extra: load_skill\r\ndata: {"type":"ping","n":9007199254740993}\r\n\r\n'
  const frames = [
    start(2, 'Agent'), start(7, 'Skill'), start(9, 'ExitPlanMode'),
    delta(2, '{"subagent_type":"ass'), delta(7, '{"skill":"stan'),
    ping,
    delta(9, '{"allowedPrompts":[{"tool":"she'),
    delta(2, 'istant","prompt":"assistant shell"}'),
    delta(7, 'dard:pdf","args":"standard:pdf"}'), stop(7),
    delta(9, 'll","prompt":"shell"},{"tool":"read_file"}],"tool":"shell"}'), stop(9), stop(2),
    event('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 55 } }), event('message_stop'),
  ]
  const output = (await restore(frames.map(frame => Buffer.from(frame)))).toString()
  assert.ok(output.includes(ping))
  const before = events(frames.join('')).map(item => [item.type, item.index])
  assert.deepEqual(events(output).map(item => [item.type, item.index]), before)
  assert.deepEqual(JSON.parse(inputOf(output, 2)), { subagent_type: 'claude', prompt: 'assistant shell' })
  assert.deepEqual(JSON.parse(inputOf(output, 7)), { skill: 'anthropic-skills:pdf', args: 'standard:pdf' })
  assert.deepEqual(JSON.parse(inputOf(output, 9)), { allowedPrompts: [{ tool: 'Bash', prompt: 'shell' }, { tool: 'Read' }], tool: 'shell' })
})

test('escaped keys and selector tokens decode across every input fragment boundary', OPTIONS, async () => {
  const input = '{"subagent_\\u0074ype":"cl\\u0069ent-guide","prompt":"assistant \\"quote\\" café","values":[-0,1.200e+30,true,false,null,{"subagent_type":"assistant"}]}'
  const expected = input.replace('"cl\\u0069ent-guide"', '"claude-code-guide"')
  for (let index = 0; index <= input.length; index++) {
    const frames = start(0, 'Agent') + delta(0, input.slice(0, index)) + delta(0, input.slice(index)) + stop(0)
    assert.equal(inputOf((await restore([Buffer.from(frames)])).toString(), 0), expected, `input split at ${index}`)
  }
  const frames = [start(0, 'Agent'), ...Array.from(input, char => delta(0, char)), stop(0)]
  assert.equal(inputOf((await restore(frames.map(frame => Buffer.from(frame)))).toString(), 0), expected)
})

test('known selector paths alone change, even with nested arrays and duplicate fields', OPTIONS, async () => {
  const input = '{"allowedPrompts":[{"tool":"shell","nested":{"tool":"shell"}},[{"tool":"shell"}],null,{"tool":"read_file","tool":"shell"}],"other":{"allowedPrompts":[{"tool":"shell"}]},"prompt":"shell"}'
  const output = (await restore([Buffer.from(start(0, 'ExitPlanMode') + delta(0, input) + stop(0))])).toString()
  assert.equal(inputOf(output, 0), '{"allowedPrompts":[{"tool":"Bash","nested":{"tool":"shell"}},[{"tool":"shell"}],null,{"tool":"Read","tool":"Bash"}],"other":{"allowedPrompts":[{"tool":"shell"}]},"prompt":"shell"}')
})

test('large Write input streams one event at a time without a whole-block buffer', OPTIONS, async () => {
  const stream = createResponseTransform(codec, 'sse', 4096)
  const output: Buffer[] = []
  stream.on('data', (chunk: Buffer) => output.push(Buffer.from(chunk)))
  const completion = finished(stream)
  await write(stream, start(0, 'Write'))
  for (let index = 0; index < 256; index++) {
    const frame = delta(0, 'delegate assistant model-api '.repeat(40))
    const count = output.length
    await write(stream, frame)
    assert.equal(output.length, count + 1)
    assert.equal(output.at(-1)!.toString(), frame)
  }
  await write(stream, stop(0))
  stream.end()
  await completion
})

test('large Agent prompt streams while a split selector is withheld', OPTIONS, async () => {
  const stream = createResponseTransform(codec, 'sse', 4096)
  const output: Buffer[] = []
  stream.on('data', (chunk: Buffer) => output.push(Buffer.from(chunk)))
  const completion = finished(stream)
  await write(stream, start(0, 'Agent'))
  await write(stream, delta(0, '{"prompt":"'))
  for (let index = 0; index < 128; index++) {
    const frame = delta(0, 'assistant delegate '.repeat(60))
    const count = output.length
    await write(stream, frame)
    assert.equal(output.length, count + 1)
    assert.equal(output.at(-1)!.toString(), frame)
  }
  await write(stream, delta(0, '","subagent_type":"ass'))
  assert.equal(events(output.at(-1)!.toString())[0].delta.partial_json, '","subagent_type":')
  await write(stream, delta(0, 'istant"}'))
  assert.equal(events(output.at(-1)!.toString())[0].delta.partial_json, '"claude"}')
  await write(stream, stop(0))
  stream.end()
  await completion
  assert.equal(JSON.parse(inputOf(Buffer.concat(output).toString(), 0)).subagent_type, 'claude')
})

test('thinking, signatures, server tools, unknown events, stop reason, and usage stay exact', OPTIONS, async () => {
  const frames = [
    ': raw comment\r\nretry: 0007\r\nx-field: delegate\r\n\r\n',
    event('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: 'delegate' } }, '\r\n'),
    'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"assistant\\u0061"}}\r\n\r\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signed\\/delegate\\u0061"}}\n\n',
    stop(0),
    event('content_block_start', { index: 1, content_block: { type: 'server_tool_use', name: 'delegate', input: { subagent_type: 'assistant' } } }),
    delta(1, 'invalid JSON delegate'), stop(1),
    'event: future\r\ndata: not JSON at all\r\nx-extra: 001\r\n\r\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9223372036854775807}}\n\n',
    event('message_stop'), ': final comment without newline',
  ]
  const source = Buffer.from(frames.join(''))
  assert.deepEqual(await restore(frames.map(frame => Buffer.from(frame))), source)
  const invalidUnknown = Buffer.concat([Buffer.from('event: unknown\ndata: '), Buffer.from([0xff]), Buffer.from('\n\n')])
  assert.deepEqual(await restore([invalidUnknown]), invalidUnknown)
})

test('request-scoped codecs do not decode undeclared tool aliases', OPTIONS, async () => {
  const readOnly = createWireCodec({ tools: [{ name: 'Read', input_schema: { type: 'object' } }] })
  const source = Buffer.from(start(0, 'Agent') + delta(0, '{"subagent_type":"assistant"}') + stop(0))
  assert.deepEqual(await restore([source], 'sse', readOnly), source)
  const json = Buffer.from('{"content":[{"type":"tool_use","name":"delegate","input":{"subagent_type":"assistant"}}]}')
  assert.strictEqual(restoreJsonResponse(json, readOnly), json)
})

test('malformed and truncated selector JSON cause transform errors', OPTIONS, async () => {
  const malformed = [
    '{"subagent_type":"assistant",}', '{"subagent_type":"assistant"',
    '{"x":01}', '{"x":1.}', '{"x":1e+}', '{"x":truefalse}', '{"x":tru}',
    '{"x":"bad\\q"}', '{"x":"bad\\u12zz"}', '{"x":"bad\u0001"}',
    '{"x":[1,]}', '{"x"::1}', '[]', '{}{}', 'null', '',
  ]
  for (const input of malformed) {
    await assert.rejects(restore([Buffer.from(start(0, 'Agent') + delta(0, input) + stop(0))]), /selector tool input JSON/, input)
  }
  await assert.rejects(restore([Buffer.from(start(0, 'Agent') + delta(0, '{"prompt":"still open'))]), /Truncated/)
  await assert.rejects(restore([Buffer.from(start(0, 'Agent') + event('message_stop'))]), /open selector tool blocks/)
  await assert.rejects(restore([Buffer.from(start(0, 'Agent') + stop(0).trimEnd())]), /Truncated/)
  await assert.rejects(restore([Buffer.from('event: content_block_start\ndata: {invalid}\n\n')]), /Malformed/)
})

test('buffer caps cover full JSON, unterminated SSE events, selectors, and aggregate state', OPTIONS, async () => {
  await assert.rejects(restore([Buffer.from(' '.repeat(257))], 'json', codec, 256), /size limit/)
  await assert.rejects(restore([Buffer.from(': ' + 'x'.repeat(255))], 'sse', codec, 256), /size limit/)
  const single = [start(0, 'Agent'), delta(0, '{"subagent_type":"'), ...Array.from({ length: 10 }, () => delta(0, 'x'.repeat(64)))]
  await assert.rejects(restore(single.map(frame => Buffer.from(frame)), 'sse', codec, 512), /Selector string/)
  const multiple = [start(0, 'Agent'), start(1, 'Skill'), delta(0, '{"subagent_type":"'), delta(1, '{"skill":"')]
  for (let index = 0; index < 4; index++) multiple.push(delta(0, 'x'.repeat(64)), delta(1, 'y'.repeat(64)))
  await assert.rejects(restore(multiple.map(frame => Buffer.from(frame)), 'sse', codec, 512), /aggregate response buffer limit/)
  assert.throws(() => createResponseTransform(codec, 'sse', 0), /positive safe integer/)
})

test('v2 calls restore all mapped root keys in JSON, initial SSE inputs, and incremental inputs', OPTIONS, async () => {
  const calls = Object.entries(PARAMETER_ALIASES).map(([name, aliases]) => ({
    name,
    input: Object.fromEntries(Object.entries(aliases).map(([key, wire]) => {
      assert.equal(v2.encodeInputKey(name, key), wire)
      assert.equal(codec.encodeInputKey(name, key), key)
      assert.equal(codec.decodeInputKey(name, wire), wire)
      const value = name === 'Agent' && key === 'subagent_type' ? 'claude'
        : name === 'Skill' && key === 'skill' ? 'anthropic-skills:pdf'
          : name === 'ExitPlanMode' && key === 'allowedPrompts' ? [{ tool: 'Bash', prompt: 'shell', nested: { tool: 'shell' } }]
            : { path: 'literal', text: 'café 漢字', skill: 'model-api', [wire]: 'unchanged' }
      return [key, value]
    })),
  }))
  const wire = calls.map(call => ({ type: 'tool_use', name: v2.encodeTool(call.name), input: v2.translateInput(call.name, call.input, 'encode') }))
  const restored = JSON.parse(restoreJsonResponse(Buffer.from(JSON.stringify({ content: wire })), v2).toString())
  assert.deepEqual(restored.content.map(({ name, input }: any) => ({ name, input })), calls)
  for (const [index, call] of calls.entries()) {
    const initial = (await restore([Buffer.from(startV2(index, call.name, wire[index].input) + stop(index))], 'sse', v2)).toString()
    assert.deepEqual(events(initial)[0].content_block.input, call.input, call.name)
    const input = JSON.stringify(wire[index].input)
    const frames = [startV2(index, call.name), ...Array.from(input, char => delta(index, char)), stop(index)]
    const output = (await restore(frames.map(frame => Buffer.from(frame)), 'sse', v2)).toString()
    assert.deepEqual(JSON.parse(inputOf(output, index)), call.input, call.name)
    assert.deepEqual(v2.translateInput(call.name, JSON.parse(inputOf(output, index)), 'encode'), wire[index].input)
  }
})

test('v2 Read, Write, Edit, Bash, Agent, Skill, and ExitPlanMode round-trip literal arguments', OPTIONS, async () => {
  const calls = [
    { name: 'Read', input: { file_path: '/tmp/ação', offset: 12, limit: 8, pages: '1-2', allow_large: true } },
    { name: 'Write', input: { file_path: '/tmp/a', content: '{"path":"text","skill":"model-api"}\n' } },
    { name: 'Edit', input: { file_path: '/tmp/a', old_string: 'text', new_string: 'skill', replace_all: false } },
    { name: 'Bash', input: { command: 'printf "%s" "shell path text"', timeout: 42, description: 'ação', run_in_background: true, dangerouslyDisableSandbox: false } },
    { name: 'Agent', input: { description: 'review', prompt: 'assistant path skill', subagent_type: 'claude-code-guide', model: 'sonnet' } },
    { name: 'Skill', input: { skill: 'claude-api', args: 'model-api name skill' } },
    { name: 'ExitPlanMode', input: { allowedPrompts: [{ tool: 'Read', prompt: 'read_file', nested: { tool: 'shell' } }, { tool: 'Bash', prompt: 'shell' }] } },
  ]
  const wire = calls.map(call => ({ type: 'tool_use', name: v2.encodeTool(call.name), input: v2.translateInput(call.name, call.input, 'encode') }))
  const json = (await restore([Buffer.from(JSON.stringify({ content: wire }))], 'json', v2)).toString()
  assert.deepEqual(JSON.parse(json).content.map(({ name, input }: any) => ({ name, input })), calls)
  const frames = calls.flatMap((call, index) => [startV2(index, call.name), delta(index, JSON.stringify(wire[index].input)), stop(index)])
  const output = (await restore(frames.map(frame => Buffer.from(frame)), 'sse', v2)).toString()
  for (const [index, call] of calls.entries()) assert.deepEqual(JSON.parse(inputOf(output, index)), call.input)
})

test('v2 range edits preserve escaped literal values, nested keys, signatures, and 64-bit numbers', OPTIONS, async () => {
  const input = '{ "pa\\u0074h":"a\\/b\\u0061", "start":9223372036854775807, "count":-0, "other":{"path":"x","text":"y","skill":"model-api"}, "fraction":1.2300e+40 }'
  const expectedInput = input.replace('"pa\\u0074h"', '"file_path"').replace('"start"', '"offset"').replace('"count"', '"limit"')
  const source = '{"id":9007199254740993,"content":[{"type":"thinking","signature":"signed\\/value\\u0061"},{"type":"tool_use","name":"read_file","input":' + input + '}]}'
  const expected = source.replace('"name":"read_file"', '"name":"Read"').replace(input, expectedInput)
  assert.equal(restoreJsonResponse(Buffer.from(source), v2).toString(), expected)
  const frames = startV2(0, 'Read') + delta(0, input) + stop(0)
  assert.equal(inputOf((await restore([Buffer.from(frames)], 'sse', v2)).toString(), 0), expectedInput)
  const initial = 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"read_file","input":' + input + '}}\n\n' + stop(0)
  assert.equal((await restore([Buffer.from(initial)], 'sse', v2)).toString(), initial.replace('"name":"read_file"', '"name":"Read"').replace(input, expectedInput))
})

test('v2 escaped and non-ASCII root keys survive every fragment and UTF-8 byte boundary', OPTIONS, async () => {
  const input = '{"pa\\u0074h":"café 漢字","é\\u0061\\\"":"literal","te\\u0078t":"a\\nb\\/c","nested":{"path":"p","text":"t","skill":"model-api"}}'
  const expected = input.replace('"pa\\u0074h"', '"file_path"').replace('"te\\u0078t"', '"content"')
  for (let index = 0; index <= input.length; index++) {
    const frames = startV2(0, 'Write') + delta(0, input.slice(0, index)) + delta(0, input.slice(index)) + stop(0)
    assert.equal(inputOf((await restore([Buffer.from(frames)], 'sse', v2)).toString(), 0), expected, `input split ${index}`)
  }
  const source = Buffer.from(startV2(0, 'Write') + delta(0, input) + stop(0))
  for (let index = 0; index <= source.length; index++) {
    const output = await restore([source.subarray(0, index), source.subarray(index)], 'sse', v2)
    assert.equal(inputOf(output.toString(), 0), expected, `byte split ${index}`)
  }
  assert.equal(inputOf((await restore([...source].map(byte => Buffer.from([byte])), 'sse', v2)).toString(), 0), expected)
})

test('v2 interleaved blocks withhold root key tokens and use decoded selector contexts', OPTIONS, async () => {
  const ping = ': keep\nevent: ping\ndata: {"type":"ping","n":9223372036854775807}\n\n'
  const frames = [
    startV2(1, 'Write'), startV2(2, 'Agent'), startV2(3, 'ExitPlanMode'), startV2(4, 'Skill'),
    delta(1, '{"te'), delta(2, '{"agent_'), ping, delta(3, '{"permis'), delta(4, '{"na'),
    delta(1, 'xt":"path text"}'), stop(1), delta(3, 'sions":[{"tool":"she'),
    delta(2, 'type":"ass'), delta(4, 'me":"model-'), delta(3, 'll","prompt":"shell","nested":{"tool":"shell"}}]}'), stop(3),
    delta(2, 'istant","task":"assistant"}'), stop(2), delta(4, 'api","arguments":"model-api"}'), stop(4), event('message_stop'),
  ]
  const output = (await restore(frames.map(frame => Buffer.from(frame)), 'sse', v2)).toString()
  const parsed = events(output)
  assert.deepEqual(parsed.map(item => [item.type, item.index]), events(frames.join('')).map(item => [item.type, item.index]))
  assert.ok(output.includes(ping))
  assert.deepEqual(parsed.filter(item => item.type === 'content_block_delta').slice(0, 4).map(item => item.delta.partial_json), ['{', '{', '{', '{'])
  assert.deepEqual(JSON.parse(inputOf(output, 1)), { content: 'path text' })
  assert.deepEqual(JSON.parse(inputOf(output, 2)), { subagent_type: 'claude', prompt: 'assistant' })
  assert.deepEqual(JSON.parse(inputOf(output, 3)), { allowedPrompts: [{ tool: 'Bash', prompt: 'shell', nested: { tool: 'shell' } }] })
  assert.deepEqual(JSON.parse(inputOf(output, 4)), { skill: 'claude-api', args: 'model-api' })
})

test('v2 rejects decoded root-key collisions in JSON and both SSE input forms', OPTIONS, async () => {
  const cases = [
    ['{"path":"a","file_path":"b"}', /^Parameter alias collision: reserved native key file_path for Write$/],
    ['{"file_path":"a","pa\\u0074h":"b"}', /^Parameter alias collision: reserved native key file_path for Write$/],
    ['{"text":"a","content":"b"}', /^Parameter alias collision: reserved native key content for Write$/],
    ['{"path":"a","path":"b"}', /^Duplicate decoded root input key: file_path$/],
  ] as const
  for (const [input, message] of cases) {
    const source = '{"content":[{"type":"tool_use","name":"write_file","input":' + input + '}]}'
    assert.throws(() => restoreJsonResponse(Buffer.from(source), v2), { message })
    const initial = 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"write_file","input":' + input + '}}\n\n'
    await assert.rejects(restore([Buffer.from(initial + stop(0))], 'sse', v2), { message })
    const frames = [startV2(0, 'Write'), ...Array.from(input, char => delta(0, char)), stop(0)]
    await assert.rejects(restore(frames.map(frame => Buffer.from(frame)), 'sse', v2), { message })
  }
})

test('v2 large valid Write values stream without retaining the tool input', OPTIONS, async () => {
  const stream = createResponseTransform(v2, 'sse', 4096)
  const output: Buffer[] = []
  stream.on('data', (chunk: Buffer) => output.push(Buffer.from(chunk)))
  const completion = finished(stream)
  await write(stream, startV2(0, 'Write'))
  await write(stream, delta(0, '{"path":"/tmp/a","te'))
  assert.equal(events(output.at(-1)!.toString())[0].delta.partial_json, '{"file_path":"/tmp/a",')
  await write(stream, delta(0, 'xt":"'))
  assert.equal(events(output.at(-1)!.toString())[0].delta.partial_json, '"content":"')
  const value = 'delegate assistant model-api café '.repeat(40)
  for (let index = 0; index < 256; index++) {
    const frame = delta(0, value)
    const count = output.length
    await write(stream, frame)
    assert.equal(output.length, count + 1)
    assert.equal(output.at(-1)!.toString(), frame)
  }
  await write(stream, delta(0, '"}'))
  await write(stream, stop(0))
  stream.end()
  await completion
  assert.deepEqual(JSON.parse(inputOf(Buffer.concat(output).toString(), 0)), { file_path: '/tmp/a', content: value.repeat(256) })
})

test('v2 root keys reject malformed, truncated, and oversized tokens without leaking them', OPTIONS, async () => {
  for (const input of ['{"pa', '{"pa\\', '{"pa\\u12', '{"pa\\q":0}', '{"pa\\u12zz":0}', '{"pa\u0001":0}']) {
    const frames = startV2(0, 'Read') + delta(0, input) + stop(0)
    await assert.rejects(restore([Buffer.from(frames)], 'sse', v2), /selector tool input JSON/)
  }
  const longInput = '{"' + 'x'.repeat(255) + '":"literal"}'
  assert.throws(() => restoreJsonResponse(Buffer.from('{"content":[{"type":"tool_use","name":"read_file","input":' + longInput + '}]}'), v2), /Root input key exceeds/)
  await assert.rejects(restore([Buffer.from(startV2(0, 'Read') + delta(0, longInput) + stop(0))], 'sse', v2), /Root input key exceeds/)
  const legacy = start(0, 'Agent') + delta(0, longInput) + stop(0)
  assert.equal(inputOf((await restore([Buffer.from(legacy)])).toString(), 0), longInput)
  const stream = createResponseTransform(v2, 'sse')
  const output: Buffer[] = []
  stream.on('data', (chunk: Buffer) => output.push(Buffer.from(chunk)))
  const completion = finished(stream)
  const rejected = assert.rejects(completion, /Truncated/)
  await write(stream, startV2(0, 'Read'))
  await write(stream, delta(0, '{"pa'))
  assert.equal(inputOf(Buffer.concat(output).toString(), 0), '{')
  stream.end()
  await rejected
})

test('v2 bounds root-key collision state and releases it between completed blocks', OPTIONS, async () => {
  const stream = createResponseTransform(v2, 'sse', 512)
  stream.resume()
  const completion = finished(stream)
  for (let index = 0; index < 20; index++) {
    await write(stream, startV2(index, 'Write'))
    await write(stream, delta(index, '{"path":"a","text":"b"}'))
    await write(stream, stop(index))
  }
  stream.end()
  await completion
  const frames = [startV2(0, 'Write'), delta(0, '{')]
  for (let index = 0; index < 20; index++) frames.push(delta(0, `${index ? ',' : ''}"key${index}":0`))
  await assert.rejects(restore(frames.map(frame => Buffer.from(frame)), 'sse', v2, 512), /aggregate response buffer limit/)
})

test('v2 cancellation discards a withheld root key and still enforces depth and block limits', OPTIONS, async () => {
  const stream = createResponseTransform(v2, 'sse')
  const output: Buffer[] = []
  stream.on('data', (chunk: Buffer) => output.push(Buffer.from(chunk)))
  const completion = finished(stream)
  const rejected = assert.rejects(completion, /cancelled/)
  await write(stream, startV2(0, 'Write'))
  await write(stream, delta(0, '{"te'))
  stream.destroy(new Error('cancelled'))
  await rejected
  assert.equal(inputOf(Buffer.concat(output).toString(), 0), '{')
  await assert.rejects(restore([Buffer.from(startV2(0, 'Read') + delta(0, '{"other":' + '['.repeat(128)))], 'sse', v2), /nesting limit/)
  await assert.rejects(restore([Buffer.from(startV2(0, 'Read') + startV2(0, 'Write'))], 'sse', v2), /Duplicate open/)
  const many = Array.from({ length: 1025 }, (_, index) => Buffer.from(startV2(index, 'Read')))
  await assert.rejects(restore(many, 'sse', v2), /Too many open/)
})

test('v2 response restoration decodes the wire tool name only once', OPTIONS, async () => {
  let names = 0
  const checked = { ...v2, decodeTool(name: string) { assert.equal(name, 'read_file'); names++; return v2.decodeTool(name) } }
  const source = Buffer.from('{"content":[{"type":"tool_use","name":"read_file","input":{"path":"a","start":5}}]}')
  assert.equal(JSON.parse(restoreJsonResponse(source, checked).toString()).content[0].input.offset, 5)
  const output = await restore([Buffer.from(startV2(0, 'Read') + delta(0, '{"path":"a","start":5}') + stop(0))], 'sse', checked)
  assert.equal(JSON.parse(inputOf(output.toString(), 0)).offset, 5)
  assert.equal(names, 2)
})

test('open block count, depth, duplicate indices, and malformed partial values are bounded', OPTIONS, async () => {
  const many = Array.from({ length: 1025 }, (_, index) => Buffer.from(start(index, 'Agent')))
  await assert.rejects(restore(many), /Too many open/)
  await assert.rejects(restore([Buffer.from(start(0, 'Agent') + start(0, 'Skill'))]), /Duplicate open/)
  await assert.rejects(restore([Buffer.from(start(0, 'Agent') + delta(0, '{"x":' + '['.repeat(128)))]), /nesting limit/)
  await assert.rejects(restore([Buffer.from(start(0, 'Agent') + event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: {} } }))]), /Invalid selector tool input delta/)
})
