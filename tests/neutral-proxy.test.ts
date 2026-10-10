import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { test } from 'node:test'
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from 'node:zlib'
import {
  bodyOf,
  call,
  CLIENT_TOKEN,
  deferred,
  gateway,
  mockServer,
  openCall,
  origin,
  TEST_OPTIONS,
  UPSTREAM_KEY,
} from './support.js'

const neutral = { path: '/agent/v1/messages', headers: { 'content-type': 'application/json' } }
const readTool = {
  name: 'Read',
  description: 'Read a file using its absolute path.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute file path.', examples: ['/tmp/Read.txt'] },
      limit: { type: 'integer', minimum: 1 },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  cache_control: { type: 'ephemeral' },
}

function tool(name: string) {
  return { name, input_schema: { type: 'object', properties: {} } }
}

function message(content: unknown[]) {
  return {
    id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock-model', content,
    stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 8 },
  }
}

function event(type: string, fields: Record<string, unknown> = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
}

function events(body: Buffer) {
  return body.toString('utf8').split('\n\n').filter(Boolean).map(frame => {
    const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
    return JSON.parse(data)
  })
}

const generatedContext = [
  '<system-reminder>',
  "As you answer the user's questions, you can use the following context:",
  '# userEmail',
  'dummy-user@example.test',
  '# gitStatus',
  'Current branch: dummy-branch',
  'Status: clean',
  'Recent commits:',
  'abcdef0 dummy commit subject',
  "Claude Code attached this context automatically; it isn't part of the user's message.",
  '</system-reminder>',
].join('\n')

const generatedAttribution = [
  '<system-reminder>',
  "Attribution for git commits and pull requests you create from here on (this replaces Claude Code's own earlier attribution guidance, such as a previous copy of this reminder; the user's own instructions about these lines, such as a CLAUDE.md or memory rule, take precedence over this reminder, but do not add attribution lines this reminder leaves out):",
  '- End pull request descriptions with:',
  '\u{1f916} Generated with [Claude Code](https://claude.com/claude-code)',
  '</system-reminder>',
].join('\n')

test('neutral JSON tools round-trip and replay with their original thinking signatures', TEST_OPTIONS, async (t) => {
  const protectedThinking = '{ "type":"thinking", "thinking":"Read Agent Skill Claude Code", "signature":"signed\\u002bRead/Claude Code==" }'
  const thinking = JSON.parse(protectedThinking)
  const redacted = { type: 'redacted_thinking', data: 'opaque-Read-Agent-Claude-Code==' }
  const literal = 'Keep Read, Write, Bash, Agent, Skill, claude-code-guide and anthropic-skills:pdf literally in /tmp/Read.txt.'
  const tools = [
    readTool,
    {
      name: 'Agent',
      input_schema: { type: 'object', properties: { subagent_type: { type: 'string', enum: ['Explore', 'claude-code-guide'] } } },
    },
    {
      name: 'Skill',
      input_schema: { type: 'object', properties: { skill: { type: 'string', enum: ['claude-api', 'anthropic-skills:pdf'] } } },
    },
    tool('Bash'), tool('Write'), tool('ExitPlanMode'),
  ]
  const wireContent = [
    thinking,
    redacted,
    { type: 'tool_use', id: 'read_next', name: 'read_file', input: { file_path: '/tmp/Read.txt', limit: 7 } },
    { type: 'tool_use', id: 'agent_next', name: 'delegate', input: { subagent_type: 'client-guide', prompt: literal } },
    { type: 'tool_use', id: 'skill_next', name: 'load_skill', input: { skill: 'standard:pdf', args: literal } },
    { type: 'tool_use', id: 'plan_next', name: 'finish_planning', input: { allowedPrompts: [{ tool: 'shell', prompt: literal }] } },
  ]
  const nativeContent = [
    thinking,
    redacted,
    { ...wireContent[2], name: 'Read' },
    { ...wireContent[3], name: 'Agent', input: { subagent_type: 'claude-code-guide', prompt: literal } },
    { ...wireContent[4], name: 'Skill', input: { skill: 'anthropic-skills:pdf', args: literal } },
    { ...wireContent[5], name: 'ExitPlanMode', input: { allowedPrompts: [{ tool: 'Bash', prompt: literal }] } },
  ]
  const received: Buffer[] = []
  const upstream = await mockServer(t, async (req, res) => {
    received.push(await bodyOf(req))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(message(wireContent)).replace(JSON.stringify(thinking), protectedThinking))
  })
  const proxy = await gateway(t, origin(upstream))
  const request = {
    model: 'mock-model', max_tokens: 256,
    metadata: { user_id: 'dummy-session', retained: 'unchanged' },
    system: [
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: 'ephemeral' } },
      { type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
    ],
    thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, tools,
    tool_choice: { type: 'tool', name: 'Read', disable_parallel_tool_use: true },
    messages: [
      { role: 'user', content: [{ type: 'text', text: generatedContext }, { type: 'text', text: generatedAttribution }, { type: 'text', text: literal }] },
      { role: 'assistant', content: [
        thinking, redacted,
        { type: 'tool_use', id: 'read_old', name: 'Read', input: { file_path: '/tmp/Read.txt' } },
        { type: 'tool_use', id: 'agent_old', name: 'Agent', input: { subagent_type: 'Explore', prompt: literal } },
        { type: 'tool_use', id: 'skill_old', name: 'Skill', input: { skill: 'claude-api', args: literal } },
      ] },
      { role: 'user', content: ['read_old', 'agent_old', 'skill_old'].map(id => ({ type: 'tool_result', tool_use_id: id, content: literal })) },
    ],
  }
  const payload = JSON.stringify(request).replace(JSON.stringify(thinking), protectedThinking)
  const response = await call(proxy, neutral, payload)
  assert.equal(response.status, 200)
  const wire = JSON.parse(received[0].toString())
  assert.deepEqual(wire.tools, [
    { ...readTool, name: 'read_file' },
    { ...tools[1], name: 'delegate', input_schema: { type: 'object', properties: { subagent_type: { type: 'string', enum: ['explorer', 'client-guide'] } } } },
    { ...tools[2], name: 'load_skill', input_schema: { type: 'object', properties: { skill: { type: 'string', enum: ['model-api', 'standard:pdf'] } } } },
    tool('shell'), tool('write_file'), tool('finish_planning'),
  ])
  assert.deepEqual(wire.tool_choice, { ...request.tool_choice, name: 'read_file' })
  assert.deepEqual(wire.metadata, { retained: 'unchanged' })
  assert.deepEqual(wire.thinking, request.thinking)
  assert.deepEqual(wire.output_config, request.output_config)
  assert.deepEqual(wire.system, request.system.map(block => ({ ...block, text: "You are a coding assistant working in the user's local environment." })))
  assert.equal(wire.messages[0].content.length, 2)
  assert.match(wire.messages[0].content[0].text, /dummy-user@example\.test/)
  assert.doesNotMatch(wire.messages[0].content[0].text, /gitStatus|dummy-branch|dummy commit subject|attached this context/)
  assert.equal(wire.messages[0].content[1].text, literal)
  assert.deepEqual(wire.messages[2], request.messages[2])
  assert.deepEqual(wire.messages[1].content, [
    thinking, redacted,
    { type: 'tool_use', id: 'read_old', name: 'read_file', input: { file_path: '/tmp/Read.txt' } },
    { type: 'tool_use', id: 'agent_old', name: 'delegate', input: { subagent_type: 'explorer', prompt: literal } },
    { type: 'tool_use', id: 'skill_old', name: 'load_skill', input: { skill: 'model-api', args: literal } },
  ])
  assert.equal(received[0].includes(protectedThinking), true)
  assert.equal(response.body.includes(protectedThinking), true)
  const restored = JSON.parse(response.body.toString())
  assert.deepEqual(restored, message(nativeContent))

  const followup = {
    ...request,
    messages: [...request.messages,
      { role: 'assistant', content: restored.content },
      { role: 'user', content: ['read_next', 'agent_next', 'skill_next', 'plan_next'].map(id => ({ type: 'tool_result', tool_use_id: id, content: literal })) },
    ],
  }
  assert.equal((await call(proxy, neutral, JSON.stringify(followup))).status, 200)
  assert.equal(received.length, 2)
  const replay = JSON.parse(received[1].toString())
  assert.deepEqual(replay.messages.slice(0, wire.messages.length), wire.messages)
  assert.deepEqual(replay.messages.at(-2).content, wireContent)
  assert.deepEqual(replay.messages.at(-1), followup.messages.at(-1))
  assert.deepEqual(replay.tools, wire.tools)
  assert.deepEqual(replay.system, wire.system)
})

test('neutral routes strip only the local prefix, preserve queries and retain the configured origin', TEST_OPTIONS, async (t) => {
  const seen: Array<{ path: string; host: string | undefined; name: string }> = []
  let foreignRequests = 0
  const foreign = await mockServer(t, (req, res) => { foreignRequests++; req.resume(); res.end() })
  const upstream = await mockServer(t, async (req, res) => {
    const body = JSON.parse((await bodyOf(req)).toString())
    seen.push({ path: req.url!, host: req.headers.host, name: body.tools[0].name })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"input_tokens":17}')
  })
  const proxy = await gateway(t, `${origin(upstream)}/ignored/base`)
  const query = `?literal=%2Fagent%2FRead&target=${encodeURIComponent(origin(foreign))}&same=1&same=2`
  for (const path of ['/agent/v1/messages', '/agent/v1/messages/count_tokens', '/v1/messages', '/v1/messages/count_tokens']) {
    const response = await call(proxy, { ...neutral, path: path + query, headers: { ...neutral.headers, host: new URL(origin(foreign)).host } }, JSON.stringify({ tools: [readTool] }))
    assert.equal(response.status, 200)
    assert.deepEqual(JSON.parse(response.body.toString()), { input_tokens: 17 })
  }
  assert.deepEqual(seen, [
    { path: '/v1/messages' + query, host: new URL(origin(upstream)).host, name: 'read_file' },
    { path: '/v1/messages/count_tokens' + query, host: new URL(origin(upstream)).host, name: 'read_file' },
    { path: '/v1/messages' + query, host: new URL(origin(upstream)).host, name: 'Read' },
    { path: '/v1/messages/count_tokens' + query, host: new URL(origin(upstream)).host, name: 'Read' },
  ])
  for (const path of ['/agent//evil', `/agent//${new URL(origin(foreign)).host}/v1/messages`]) {
    assert.equal((await call(proxy, { ...neutral, path }, '{}')).status, 400)
  }
  assert.equal(seen.length, 4)
  assert.equal(foreignRequests, 0)
})

test('neutral verification advertises its profile without exposing credentials or contacting upstream', TEST_OPTIONS, async (t) => {
  let requests = 0
  const upstream = await mockServer(t, (req, res) => { requests++; req.resume(); res.end() })
  const proxy = await gateway(t, origin(upstream))
  assert.equal((await call(proxy, { path: '/agent/_verify', method: 'GET', token: null })).status, 401)
  const response = await call(proxy, { path: '/agent/_verify', method: 'GET' })
  assert.equal(response.status, 200)
  const verified = JSON.parse(response.body.toString())
  assert.equal(verified.profile, 'neutral-v1')
  assert.equal(verified.headers['x-api-key'], '[redacted]')
  for (const secret of [CLIENT_TOKEN, UPSTREAM_KEY, 'test-client']) assert.equal(response.body.includes(secret), false)
  const legacy = await call(proxy, { path: '/_verify', method: 'GET' })
  assert.equal(JSON.parse(legacy.body.toString()).profile, 'opencode-private')
  assert.equal(requests, 0)
})

test('neutral SSE restores interleaved tool indices and selector fragments before tool stop', TEST_OPTIONS, async (t) => {
  const release = deferred()
  const firstRead = deferred()
  t.after(() => release.resolve())
  const starts = ['read_file', 'write_file', 'delegate', 'load_skill'].map((name, index) => event('content_block_start', {
    index, content_block: { type: 'tool_use', id: `tool_${index}`, name, input: {} },
  })).join('')
  const inputs = [
    '{"file_path":"/tmp/café.txt"}',
    '{"file_path":"/tmp/out.txt","content":"Read, delegate and café stay literal"}',
    '{"subagent_type":"explorer","prompt":"use Read literally"}',
    '{"skill":"standard:pdf","args":"load_skill stays literal"}',
  ]
  const fragments = inputs.map(input => [input.slice(0, 20), input.slice(20, 24), input.slice(24)])
  let ending = ''
  for (let part = 0; part < 3; part++) {
    for (let index = 0; index < inputs.length; index++) ending += event('content_block_delta', {
      index, delta: { type: 'input_json_delta', partial_json: fragments[index][part] },
    })
  }
  for (const index of [2, 0, 3, 1]) ending += event('content_block_stop', { index })
  ending += event('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } })
  ending += event('message_stop')
  const upstream = await mockServer(t, async (req, res) => {
    await bodyOf(req)
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    res.write(starts)
    await release.promise
    const bytes = Buffer.from(ending)
    const split = bytes.indexOf(Buffer.from('é')) + 1
    assert.ok(split > 0)
    res.write(bytes.subarray(0, split))
    await nextTurn()
    res.end(bytes.subarray(split))
  })
  const proxy = await gateway(t, origin(upstream))
  let completed = false
  let early = ''
  const exchange = openCall(proxy, {
    ...neutral,
    onResponse: response => response.on('data', chunk => {
      early += chunk.toString()
      if (early.includes('"name":"Read"')) firstRead.resolve()
    }),
  })
  t.after(() => exchange.req.destroy())
  void exchange.finished.then(() => { completed = true }, () => { completed = true })
  exchange.req.end(JSON.stringify({ stream: true, tools: [readTool, tool('Write'), tool('Agent'), tool('Skill')] }))
  await firstRead.promise
  assert.equal(completed, false)
  release.resolve()
  const response = await exchange.finished
  assert.equal(response.status, 200)
  assert.equal(response.complete, true)
  const frames = events(response.body)
  assert.deepEqual(frames.filter(frame => frame.type === 'content_block_start').map(frame => frame.content_block.name), ['Read', 'Write', 'Agent', 'Skill'])
  const collected = ['', '', '', '']
  const stopped: number[] = []
  for (const frame of frames) {
    if (frame.type === 'content_block_delta') {
      assert.equal(stopped.includes(frame.index), false)
      collected[frame.index] += frame.delta.partial_json
    }
    if (frame.type === 'content_block_stop') {
      JSON.parse(collected[frame.index])
      stopped.push(frame.index)
    }
  }
  assert.deepEqual(stopped, [2, 0, 3, 1])
  assert.deepEqual(collected.map(input => JSON.parse(input)), [
    JSON.parse(inputs[0]), JSON.parse(inputs[1]),
    { subagent_type: 'Explore', prompt: 'use Read literally' },
    { skill: 'anthropic-skills:pdf', args: 'load_skill stays literal' },
  ])
  assert.deepEqual(frames.at(-2).delta, { stop_reason: 'tool_use', stop_sequence: null })
  assert.equal(frames.at(-1).type, 'message_stop')
})

const compressors = { gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync, zstd: zstdCompressSync }
const encodingChains: Array<Array<keyof typeof compressors>> = [['gzip'], ['deflate'], ['br'], ['zstd'], ['gzip', 'deflate', 'br', 'zstd']]
for (const mode of ['json', 'sse'] as const) {
  for (const chain of encodingChains) {
    test(`neutral ${mode} decodes ${chain.join(', ')} and removes stale representation headers`, TEST_OPTIONS, async (t) => {
      const block = { type: 'tool_use', id: 'compressed_tool', name: 'read_file', input: { file_path: '/tmp/café.txt' } }
      const plain = mode === 'json' ? JSON.stringify(message([block])) : event('content_block_start', { index: 0, content_block: block }) + event('content_block_stop', { index: 0 }) + event('message_stop')
      let compressed: Buffer = Buffer.from(plain)
      for (const encoding of chain) compressed = compressors[encoding](compressed)
      const upstream = await mockServer(t, async (req, res) => {
        await bodyOf(req)
        res.writeHead(200, {
          'content-type': mode === 'json' ? 'application/json' : 'text/event-stream',
          'content-encoding': chain.join(', '), 'content-length': String(compressed.length),
          'content-md5': 'stale-md5', digest: 'sha-256=stale', 'content-digest': 'sha-256=:stale:',
          'repr-digest': 'sha-256=:stale:', etag: '"stale-etag"', 'request-id': 'mock-compressed',
        })
        res.end(compressed)
      })
      const proxy = await gateway(t, origin(upstream))
      const response = await call(proxy, { ...neutral, headers: { ...neutral.headers, 'accept-encoding': chain.join(', ') } }, JSON.stringify({ tools: [readTool], stream: mode === 'sse' }))
      assert.equal(response.status, 200)
      for (const header of ['content-length', 'content-encoding', 'content-md5', 'digest', 'content-digest', 'repr-digest', 'etag']) assert.equal(response.headers[header], undefined, header)
      assert.equal(response.headers['request-id'], 'mock-compressed')
      const restored = { ...block, name: 'Read' }
      if (mode === 'json') assert.deepEqual(JSON.parse(response.body.toString()), message([restored]))
      else assert.deepEqual(events(response.body), [
        { type: 'content_block_start', index: 0, content_block: restored },
        { type: 'content_block_stop', index: 0 }, { type: 'message_stop' },
      ])
    })
  }
}

test('neutral compressed upstream errors bypass translation byte for byte', TEST_OPTIONS, async (t) => {
  const payload = gzipSync(Buffer.from(JSON.stringify({
    type: 'error', error: { type: 'invalid_request_error', message: 'read_file and delegate are unavailable' },
    content: [{ type: 'tool_use', id: 'error_tool', name: 'read_file', input: {} }],
  })))
  const upstream = await mockServer(t, async (req, res) => {
    await bodyOf(req)
    res.writeHead(400, {
      'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(payload.length),
      digest: 'sha-256=unchanged', etag: '"error-etag"', 'retry-after': '17', 'request-id': 'mock-error',
    })
    res.end(payload)
  })
  const proxy = await gateway(t, origin(upstream))
  const response = await call(proxy, neutral, JSON.stringify({ tools: [readTool, tool('Agent')] }))
  assert.equal(response.status, 400)
  assert.deepEqual(response.body, payload)
  assert.equal(response.headers['content-encoding'], 'gzip')
  assert.equal(response.headers['content-length'], String(payload.length))
  assert.equal(response.headers.digest, 'sha-256=unchanged')
  assert.equal(response.headers.etag, '"error-etag"')
  assert.equal(response.headers['retry-after'], '17')
  assert.equal(response.headers['request-id'], 'mock-error')
})

test('simultaneous neutral requests keep their tool catalogs isolated', TEST_OPTIONS, async (t) => {
  const bothArrived = deferred()
  t.after(() => bothArrived.resolve())
  const seen: string[][] = []
  const wireContent = [
    { type: 'tool_use', id: 'read', name: 'read_file', input: {} },
    { type: 'tool_use', id: 'write', name: 'write_file', input: {} },
  ]
  const upstream = await mockServer(t, async (req, res) => {
    const body = JSON.parse((await bodyOf(req)).toString())
    seen.push(body.tools.map((entry: { name: string }) => entry.name))
    if (seen.length === 2) bothArrived.resolve()
    await bothArrived.promise
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(message(wireContent)))
  })
  const proxy = await gateway(t, origin(upstream))
  const [read, write] = await Promise.all([
    call(proxy, neutral, JSON.stringify({ tools: [readTool, tool('write_file')] })),
    call(proxy, neutral, JSON.stringify({ tools: [tool('read_file'), tool('Write')] })),
  ])
  assert.equal(read.status, 200)
  assert.equal(write.status, 200)
  assert.deepEqual(seen, [['read_file', 'write_file'], ['read_file', 'write_file']])
  assert.deepEqual(JSON.parse(read.body.toString()).content, [{ ...wireContent[0], name: 'Read' }, wireContent[1]])
  assert.deepEqual(JSON.parse(write.body.toString()).content, [wireContent[0], { ...wireContent[1], name: 'Write' }])
})

test('a custom tool colliding with a neutral alias is rejected before contacting upstream', TEST_OPTIONS, async (t) => {
  let requests = 0
  const upstream = await mockServer(t, (req, res) => { requests++; req.resume(); res.end() })
  const proxy = await gateway(t, origin(upstream))
  const response = await call(proxy, neutral, JSON.stringify({ tools: [readTool, tool('read_file')] }))
  assert.equal(response.status, 400)
  assert.equal(JSON.parse(response.body.toString()).error.type, 'invalid_request_error')
  assert.equal(requests, 0)
})

test('unsupported neutral response encoding produces a sanitized 502 before upstream headers escape', TEST_OPTIONS, async (t) => {
  const upstream = await mockServer(t, async (req, res) => {
    await bodyOf(req)
    res.writeHead(200, {
      'content-type': 'application/json', 'content-encoding': 'private-unsupported-codec',
      etag: '"upstream-only"', 'x-upstream-only': 'private-response-header',
    })
    res.end(JSON.stringify({ content: [{ type: 'tool_use', name: 'read_file' }], private: UPSTREAM_KEY }))
  })
  const proxy = await gateway(t, origin(upstream))
  const response = await call(proxy, neutral, JSON.stringify({ tools: [readTool] }))
  assert.equal(response.status, 502)
  assert.equal(JSON.parse(response.body.toString()).error.type, 'api_error')
  assert.equal(response.headers['content-encoding'], undefined)
  assert.equal(response.headers.etag, undefined)
  assert.equal(response.headers['x-upstream-only'], undefined)
  for (const value of [CLIENT_TOKEN, UPSTREAM_KEY, 'private-unsupported-codec', 'private-response-header', 'read_file']) assert.equal(response.body.includes(value), false)
})

test('disconnecting a neutral client closes its compressed upstream stream', TEST_OPTIONS, async (t) => {
  const upstreamClosed = deferred()
  const upstream = await mockServer(t, async (req, res) => {
    await bodyOf(req)
    res.once('close', () => upstreamClosed.resolve())
    res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' })
    res.write(gzipSync(Buffer.from(event('content_block_start', {
      index: 0, content_block: { type: 'tool_use', id: 'cancel_read', name: 'read_file', input: {} },
    }))))
  })
  const proxy = await gateway(t, origin(upstream))
  let received = ''
  const exchange = openCall(proxy, {
    ...neutral,
    onResponse: response => response.on('data', chunk => {
      received += chunk.toString()
      if (received.includes('"name":"Read"')) response.destroy()
    }),
  })
  t.after(() => exchange.req.destroy())
  exchange.req.end(JSON.stringify({ stream: true, tools: [readTool] }))
  await upstreamClosed.promise
  const response = await exchange.finished
  assert.equal(response.status, 200)
  assert.equal(response.complete, false)
  assert.match(received, /"name":"Read"/)
  assert.equal(response.headers['content-encoding'], undefined)
})
