import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONTEXT_ATTRIBUTION, PRIVATE_CONTEXT_ATTRIBUTION, prepareNeutralRequest } from '../src/body.js'
import { rewriteGeneratedContext } from '../src/context.js'
import { createWireCodec } from '../src/wire-profile.js'

const codec = createWireCodec({ tools: ['Agent', 'Bash', 'Read', 'Write', 'Skill'].map(name => ({ name, input_schema: { type: 'object' } })) })
const contextStart = "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n"
const attribution = "<system-reminder>\nAttribution for git commits and pull requests you create from here on (this replaces Claude Code's own earlier attribution guidance, such as a previous copy of this reminder; the user's own instructions about these lines, such as a CLAUDE.md or memory rule, take precedence over this reminder, but do not add attribution lines this reminder leaves out):\n- End git commit messages with:\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n- End pull request descriptions with:\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n</system-reminder>\n"
const rewrite = (text: string, role: 'system' | 'user' = 'system') => rewriteGeneratedContext(text, role, codec)

test('only exact stock identities are neutralized', () => {
  for (const identity of ["You are Claude Code, Anthropic's official CLI for Claude.", "You are a Claude agent, built on Anthropic's Claude Agent SDK."]) {
    assert.equal(rewrite(identity), "You are a coding assistant working in the user's local environment.")
    assert.equal(rewrite(identity, 'user'), identity)
    assert.equal(rewrite(`Quote: ${identity}`), `Quote: ${identity}`)
    assert.equal(rewrite(`${identity} Keep this custom role.`), `${identity} Keep this custom role.`)
  }
})

test('stock harness retains safety, permissions, memory format, paths and model facts', () => {
  const keep = [
    'Assist only with authorized security testing.',
    'A denied call means the user declined it. Never bypass permissions.',
    '# Memory',
    'Memory directory: `/home/example/.claude/projects/sample/memory/`.',
    'Each file has name, description and type frontmatter; link [[related]] in the body.',
    'At most 6 concurrent agents and 25 tasks per agent.',
    'Model ID: claude-opus-5-5. The context window is 1M tokens.',
  ]
  const text = ['# Harness', 'Use the Bash tool and the Read tool in Claude Code.', ...keep,
    ' - Claude Code is available as a CLI in the terminal, desktop app (Mac/Windows), web app (claude.ai/code), and IDE extensions (VS Code, JetBrains).',
    ' - Fast mode for Claude Code uses Claude Opus with faster output (it does not downgrade to a smaller model). It can be toggled with /fast.',
  ].join('\n')
  const result = rewrite(text)!
  assert.ok(result.includes('Use the shell tool and the read_file tool in the coding client.'))
  for (const line of keep) assert.ok(result.includes(line), line)
  assert.ok(!result.includes('IDE extensions'))
  assert.ok(!result.includes('/fast'))
  assert.equal(rewrite(text, 'user'), text)
  assert.equal(rewrite(text.replace('# Memory', '# Custom')), text.replace('# Memory', '# Custom'))
  const custom = 'My system prompt mentions Claude Code and the Bash tool. # Memory appears inline.'
  assert.equal(rewrite(custom), custom)
})

test('generated git snapshot removal keeps user, date and subsequent context sections', () => {
  for (const footer of [CONTEXT_ATTRIBUTION, PRIVATE_CONTEXT_ATTRIBUTION]) {
    const text = contextStart + '# userEmail\nuser@example.invalid\n# gitStatus\nCurrent branch: private\nStatus: modified\nRecent commits:\nsecret commit text\n# currentDate\n2026-01-01\n\n' + footer + " It describes the user's own account and workspace, so they don't need it reported back.\n</system-reminder>\n"
    const result = rewrite(text, 'user')!
    assert.ok(result.includes('# userEmail\nuser@example.invalid'))
    assert.ok(result.includes('# currentDate\n2026-01-01'))
    assert.ok(result.endsWith('</system-reminder>\n'))
    assert.ok(!result.includes('gitStatus'))
    assert.ok(!result.includes('secret commit'))
    assert.ok(!result.includes('attached this context'))
    assert.equal(rewrite(result, 'user'), result)
  }
  const project = contextStart + '# gitStatus\nPlease include this project information.\n</system-reminder>'
  assert.equal(rewrite(project, 'user'), project)
  const quoted = `Quote: ${contextStart}# gitStatus\nprivate\n${CONTEXT_ATTRIBUTION}\n</system-reminder>`
  assert.equal(rewrite(quoted, 'user'), quoted)
})

test('only complete generated model attribution templates are removed', () => {
  assert.equal(rewrite(attribution, 'user'), undefined)
  const prOnly = attribution.replace('- End git commit messages with:\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n', '')
  assert.equal(rewrite(prOnly), undefined)
  for (const text of [
    'Always include Co-Authored-By: Human <human@example.invalid> in git commits.',
    attribution.replace('Claude Opus 5.5 <noreply@anthropic.com>', 'Human <human@example.invalid>'),
    attribution.replace('</system-reminder>', 'Keep project attribution rules.\n</system-reminder>'),
    `<system-reminder>\nProject instructions:\n${attribution}</system-reminder>`,
    `Quoted template:\n${attribution}`,
  ]) assert.equal(rewrite(text, 'user'), text)
})

test('generated environment catalogs map selectors and tool references without changing actual facts', () => {
  const prefix = '# Environment\nYou have been invoked in the following environment: \n - Primary working directory: /home/example/.claude/project\n - Platform: linux\n - Shell: bash\n\nYou are powered by the model named Opus 5.5. The exact model ID is claude-opus-5-5.\n\n'
  const text = prefix + 'Available agent types for the Agent tool:\n- claude: Use the Bash tool in Claude Code.\n- claude-code-guide: Explain Claude Code and the Claude Agent SDK.\n- Explore: Use the Read tool.\n- Plan: Keep task limits.\n- custom: Preserve its capabilities.\n\nThe following skills are available for use with the Skill tool:\n- claude-api: Reference for the Claude API.\n\nTRIGGER: Use the Skill tool for Claude Code questions.\n\n- anthropic-skills:pdf: Read PDF files using the Read tool.\n- custom: Keep this custom skill.\n'
  const result = rewrite(text)!
  assert.ok(result.startsWith(prefix))
  assert.ok(result.includes('Available agent types for the delegate tool:'))
  assert.ok(result.includes('- assistant: Use the shell tool in the coding client.'))
  assert.ok(result.includes('- client-guide: Explain the coding client and the agent SDK.'))
  assert.ok(result.includes('- explorer: Use the read_file tool.'))
  assert.ok(result.includes('- planner: Keep task limits.'))
  assert.ok(result.includes('- model-api: Reference for the Claude API.'))
  assert.ok(result.includes('TRIGGER: Use the load_skill tool for the coding client questions.'))
  assert.ok(result.includes('- standard:pdf: Read PDF files using the read_file tool.'))
  assert.ok(result.includes('- custom: Keep this custom skill.'))
  assert.equal(rewrite(text, 'user'), text)
  assert.equal(rewrite(text.replace('You have been invoked', 'You wrote')), text.replace('You have been invoked', 'You wrote'))
})

test('attribution blocks disappear without corrupting adjacent JSON or rewriting assistant/tool text', async () => {
  const context = contextStart + '# gitStatus\nprivate\n' + CONTEXT_ATTRIBUTION + '\n</system-reminder>'
  const request = {
    metadata: { user_id: 'private' }, system: [{ type: 'text', text: attribution }],
    messages: [
      { role: 'user', content: attribution },
      { role: 'user', content: [{ type: 'text', text: attribution }, { type: 'text', text: 'Keep user text', cache_control: { type: 'ephemeral' } }, { type: 'text', text: attribution }] },
      { role: 'user', content: [{ type: 'text', text: attribution }] },
      { role: 'assistant', content: [{ type: 'text', text: context }, { type: 'thinking', thinking: attribution, signature: 'opaque' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'one', content: context }] },
    ],
  }
  const { body } = await prepareNeutralRequest(Buffer.from(JSON.stringify(request)), '/v1/messages', undefined, 1024 * 1024)
  const result = JSON.parse(body.toString())
  assert.equal(result.metadata, undefined)
  assert.equal(result.system, undefined)
  assert.equal(result.messages.length, 3)
  assert.deepEqual(result.messages[0].content, [request.messages[1].content[1]])
  assert.deepEqual(result.messages[1], request.messages[3])
  assert.deepEqual(result.messages[2], request.messages[4])
})
