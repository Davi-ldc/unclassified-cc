import type { WireCodec } from './wire-profile.js'

const identities = new Set([
  "You are Claude Code, Anthropic's official CLI for Claude.",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
])
const neutralIdentity = "You are a coding assistant working in the user's local environment."
const contextStart = "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n"
const attributionStart = "<system-reminder>\nAttribution for git commits and pull requests you create from here on (this replaces Claude Code's own earlier attribution guidance, such as a previous copy of this reminder; the user's own instructions about these lines, such as a CLAUDE.md or memory rule, take precedence over this reminder, but do not add attribution lines this reminder leaves out):\n"
const footer = /^(?:Claude Code|CC ) attached this context automatically; it isn't part of the user's message\.(?: It describes the user's own account and workspace, so they don't need it reported back\.)?$/

function generatedAttribution(text: string): boolean {
  if (!text.startsWith(attributionStart)) return false
  const rest = text.slice(attributionStart.length)
  return /^(?:- End git commit messages with:\nCo-Authored-By: Claude(?: (?:Opus|Sonnet|Haiku|Fable)(?: \d+(?:\.\d+)?)?)? <noreply@anthropic\.com>\n)?(?:- End pull request descriptions with:\n🤖 Generated with \[Claude Code\]\(https:\/\/claude\.com\/claude-code\)\n)?<\/system-reminder>\n?$/.test(rest)
    && rest !== '</system-reminder>' && rest !== '</system-reminder>\n'
}

function contextReminder(text: string): string {
  if (!text.startsWith(contextStart) || !/^<\/system-reminder>\s*$/.test(text.slice(text.lastIndexOf('</system-reminder>')))) return text
  const lines = text.slice(contextStart.length).split('\n')
  // The attribution identifies a generated snapshot; quoted or project-authored reminders stay intact.
  if (!lines.some(line => footer.test(line))) return text
  let inGit = false
  const kept: string[] = []
  for (const line of lines) {
    if (footer.test(line)) { inGit = false; continue }
    if (line === '# gitStatus') { inGit = true; continue }
    if (/^# [^#]/.test(line) || line === '</system-reminder>') inGit = false
    if (!inGit) kept.push(line)
  }
  return contextStart + kept.join('\n')
}

function clientBrand(text: string): string {
  return text.replace(/Anthropic's Claude Agent SDK|Claude Agent SDK|Claude Code/g, (brand: string, start: number) => {
    const before = text[start - 1] ?? ''
    const after = text[start + brand.length] ?? ''
    if (/[\w/@\\-]/.test(before) || /[\w/@\\-]/.test(after)) return brand
    return brand === 'Claude Code' ? 'the coding client' : brand.startsWith('Anthropic') ? 'the agent SDK' : 'agent SDK'
  })
}

function harness(text: string, codec: WireCodec): string {
  // These advertisements do not describe a tool or change the running model's capabilities.
  const withoutAds = text.split('\n').filter(line => ![
    ' - Claude Code is available as a CLI in the terminal, desktop app (Mac/Windows), web app (claude.ai/code), and IDE extensions (VS Code, JetBrains).',
    ' - Fast mode for Claude Code uses Claude Opus with faster output (it does not downgrade to a smaller model). It can be toggled with /fast.',
  ].includes(line)).join('\n')
  return codec.rewriteInstruction(clientBrand(withoutAds))
}

function environment(text: string, codec: WireCodec): string {
  const lines = text.split('\n')
  let catalog: 'agent' | 'skill' | undefined
  return lines.map(line => {
    if (line === 'Available agent types for the Agent tool:') {
      catalog = 'agent'
      return `Available agent types for the ${codec.encodeTool('Agent')} tool:`
    }
    if (line === 'The following skills are available for use with the Skill tool:') {
      catalog = 'skill'
      return `The following skills are available for use with the ${codec.encodeTool('Skill')} tool:`
    }
    if (catalog && line.startsWith('- ')) {
      const match = /^- ([^:]+(?::[^:]+)*?): /.exec(line)
      if (match) {
        const name = match[1]
        const label = codec.encodeSelector(catalog, name)
        const description = line.slice(match[0].length)
        return `- ${label}: ${codec.rewriteInstruction(clientBrand(description))}`
      }
    }
    if (/^(?:# |<|While auto mode is active:|When you launch multiple agents |Today's date is )/.test(line)) catalog = undefined
    if (catalog) return codec.rewriteInstruction(clientBrand(line))
    // Only generated instructions outside the environment facts need tool-reference translation.
    if (line.startsWith('When you launch multiple agents ') || line.startsWith('You can do much of your work through the Bash tool ')) {
      return codec.rewriteInstruction(line)
    }
    return line
  }).join('\n')
}

/** Undefined removes a fully recognized generated attribution block. */
export function rewriteGeneratedContext(text: string, role: 'system' | 'user', codec: WireCodec): string | undefined {
  if (generatedAttribution(text)) return undefined
  if (text.startsWith(contextStart)) return contextReminder(text)
  if (role !== 'system') return text
  if (identities.has(text)) return neutralIdentity
  if (/^# Harness\r?$/m.test(text) && /^# Memory\r?$/m.test(text)) return harness(text, codec)
  if (text.startsWith('# Environment\nYou have been invoked in the following environment:')
    && text.includes('\n - Primary working directory:') && text.includes('\n - Platform:')) {
    return environment(text, codec)
  }
  return text
}
