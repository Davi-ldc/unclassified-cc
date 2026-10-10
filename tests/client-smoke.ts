import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import {
  mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { loadConfig } from '../src/config.js'
import { createProxyServer } from '../src/proxy.js'
import { prepareNeutralRequest } from '../src/body.js'
import { createSetup, renderLauncher } from '../src/scripts/setup.js'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const report = join(root, 'report')
const upstreamKey = 'smoke-upstream-key-not-a-real-credential'
const expectedText = 'gateway-smoke-ok'
const toolText = 'local-fixture-read-through-the-unmodified-path'

assert.notEqual(readlinkSync('/proc/self/ns/net'), readlinkSync('/proc/1/ns/net'), 'Run in an isolated network namespace')
assert.ok(Object.values(networkInterfaces()).flat().every((address) => !address || address.internal), 'Only loopback networking is allowed')
mkdirSync(report, { recursive: true })
const workspace = mkdtempSync(join(report, 'client-smoke-'))
const claude = realpathSync(process.env.CC_GATEWAY_SMOKE_CLAUDE || join(process.env.HOME || '', '.local/bin/claude'))
const home = join(workspace, 'home')
mkdirSync(home, { recursive: true })
const fixture = join(workspace, 'fixture.txt')
const copiedFixture = join(workspace, 'copy.txt')
const editedText = 'edited-through-restored-native-arguments'
const writtenText = 'written-through-restored-native-arguments'
const shellText = 'shell-executed-through-restored-native-arguments'
const toolCalls = [
  { name: 'read_file', input: { path: fixture } },
  { name: 'edit_file', input: { path: fixture, search: toolText, replacement: editedText } },
  { name: 'write_file', input: { path: copiedFixture, text: writtenText } },
  { name: 'read_file', input: { path: copiedFixture } },
  { name: 'shell', input: { script: `printf '%s' '${shellText}'`, timeout_ms: 1000, label: 'Print the local smoke marker' } },
]
writeFileSync(fixture, `${toolText}\n`, { mode: 0o600 })

async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

async function close(server: Server) {
  server.closeAllConnections()
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
}

function stream(res: ServerResponse, model: string, step: number) {
  const tool = toolCalls[step]
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (event: string, value: object) => res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)
  send('message_start', {
    type: 'message_start',
    message: {
      id: `msg_local_${step}`, type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  })
  send('content_block_start', {
    type: 'content_block_start', index: 0,
    content_block: tool
      ? { type: 'tool_use', id: `toolu_local_${step}`, name: tool.name, input: {} }
      : { type: 'text', text: '' },
  })
  send('content_block_delta', {
    type: 'content_block_delta', index: 0,
    delta: tool
      ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) }
      : { type: 'text_delta', text: expectedText },
  })
  send('content_block_stop', { type: 'content_block_stop', index: 0 })
  send('message_delta', {
    type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 10 },
  })
  send('message_stop', { type: 'message_stop' })
  res.end()
}

const observed: Array<{ path: string; userAgent: string | undefined; bodyMatchesPolicy: boolean }> = []
const ingressBodies: Buffer[] = []
let sawIngressBeta = false
let toolRoundTrip = false
let toolStep = 0
let mockFailure: unknown

const upstream = createServer((req, res) => {
  void respond(req, res).catch((error: unknown) => {
    mockFailure = error
    if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Local mock validation failed' } }))
  })
})

async function respond(req: IncomingMessage, res: ServerResponse) {
  assert.equal(req.headers['user-agent'], 'opencode/1.18.35')
  assert.equal(req.headers['x-api-key'], upstreamKey)
  for (const name of Object.keys(req.headers)) {
    assert.ok(!/^(x-app|anthropic-beta|authorization|proxy-authorization)$/.test(name), name)
    assert.ok(!/^x-(claude-code|opencode|stainless)-/.test(name), name)
  }
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const bytes = Buffer.concat(chunks)
  const expectedBodies = await Promise.all(ingressBodies.map(body =>
    prepareNeutralRequest(body, (req.url || '/').split('?', 1)[0], undefined, 32 * 1024 * 1024, 'neutral-v2')))
  const bodyMatchesPolicy = expectedBodies.some((prepared) => prepared.body.equals(bytes))
  assert.ok(bodyMatchesPolicy, 'Gateway must change only the requested privacy fields')
  observed.push({ path: (req.url || '/').split('?', 1)[0], userAgent: req.headers['user-agent'], bodyMatchesPolicy })
  const body = bytes.length ? JSON.parse(bytes.toString('utf8')) : {}
  assert.equal(body.metadata?.user_id, undefined)
  if (req.url?.startsWith('/v1/messages/count_tokens')) {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ input_tokens: 100 }))
    return
  }
  if (req.url?.startsWith('/v1/messages')) {
    const hasRead = Array.isArray(body.tools) && body.tools.some((tool: { name?: string }) => tool.name === 'read_file')
    assert.ok(!body.tools?.some((tool: { name?: string }) => tool.name === 'Read'))
    assert.ok(!JSON.stringify(body.system).includes('You are a Claude agent'))
    if (body.stream && hasRead) {
      const blocks = body.messages.flatMap((message: { content?: unknown }) => Array.isArray(message.content) ? message.content : [])
      for (let index = 0; index < toolStep; index++) {
        const result = blocks.find((block: { type?: string; tool_use_id?: string }) => block.type === 'tool_result' && block.tool_use_id === `toolu_local_${index}`)
        assert.ok(result && !result.is_error, `Native tool step ${index} must succeed`)
        const call = blocks.find((block: { type?: string; id?: string }) => block.type === 'tool_use' && block.id === `toolu_local_${index}`)
        assert.equal(call?.name, toolCalls[index].name)
        for (const [key, value] of Object.entries(toolCalls[index].input)) assert.deepEqual(call?.input[key], value)
      }
      if (toolStep === toolCalls.length) {
        assert.equal(readFileSync(fixture, 'utf8'), `${editedText}\n`)
        assert.equal(readFileSync(copiedFixture, 'utf8'), writtenText)
        assert.ok(JSON.stringify(blocks).includes(shellText))
        toolRoundTrip = true
      }
      stream(res, body.model, toolStep++)
    } else {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        id: 'msg_local_probe', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: expectedText }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 10 },
      }))
    }
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { type: 'not_found_error', message: 'Unsupported local mock route' } }))
}

let gateway: ReturnType<typeof createProxyServer> | undefined
try {
  createSetup(workspace, 'smoke')
  const config = loadConfig(join(workspace, 'config.yaml'), { CC_GATEWAY_UPSTREAM_API_KEY: upstreamKey })
  config.upstream.url = await listen(upstream)
  config.server.port = 0
  gateway = createProxyServer(config, {})
  gateway.on('request', (req) => {
    sawIngressBeta ||= req.headers['anthropic-beta'] !== undefined
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => ingressBodies.push(Buffer.concat(chunks)))
  })
  const gatewayUrl = await listen(gateway)
  const token = config.auth.tokens[0].token
  const launcher = join(workspace, 'clients', 'cc-smoke')
  writeFileSync(launcher, renderLauncher(token, gatewayUrl), { mode: 0o700 })
  const env = {
    PATH: `${dirname(claude)}:/usr/local/bin:/usr/bin:/bin`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    TERM: 'dumb', LANG: 'C.UTF-8',
  }
  // The versioned binary is named after its version, so expose a private launcher name.
  const bin = join(workspace, 'bin')
  mkdirSync(bin)
  symlinkSync(claude, join(bin, 'claude'))
  env.PATH = `${bin}:${env.PATH}`
  const version = await exec(claude, ['--version'], { cwd: workspace, env, timeout: 15_000 })
  assert.match(version.stdout, /2\.1\.296/)
  const result = await exec(launcher, [
    '--print', '--model', 'claude-opus-5-5', '--tools', 'Read,Edit,Write,Bash', '--allowedTools', 'Read,Edit,Write,Bash', '--max-turns', '7',
    `Read ${fixture}, replace its text with ${editedText}, write ${writtenText} to ${copiedFixture}, read it back, print ${shellText} using printf, then reply with ${expectedText}.`,
  ], { cwd: workspace, env, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 })
  if (mockFailure) throw mockFailure
  assert.ok(result.stdout.includes(expectedText), 'Claude must complete the mocked request')
  assert.ok(toolStep > toolCalls.length && toolRoundTrip, 'Claude must complete native Read, Edit, Write, and Bash tool round trips')
  assert.ok(!result.stdout.includes(token) && !result.stdout.includes(upstreamKey))
  const summary = {
    client: version.stdout.trim(), network: 'isolated loopback only',
    userAgent: config.upstream.user_agent,
    clientSentBetaHeader: sawIngressBeta,
    omittedHeaders: ['x-app', 'anthropic-beta', 'x-claude-code-session-id'],
    upstreamCredentialReplaced: true,
    profile: 'neutral-v2',
    nativeToolsExecuted: ['Read', 'Edit', 'Write', 'Bash'],
    requests: observed, toolRoundTrip, credentials: 'dummy values only', liveAnthropicTest: false,
  }
  writeFileSync(join(report, 'client-smoke.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify(summary, null, 2))
} catch (error) {
  if (mockFailure) throw mockFailure
  throw error
} finally {
  if (gateway) await close(gateway)
  await close(upstream)
  rmSync(workspace, { recursive: true, force: true })
}
