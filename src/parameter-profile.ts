type RecordValue = Record<string, unknown>
type Direction = 'encode' | 'decode'
type Domain = 'agent' | 'skill' | 'tool'
type Context = 'root' | 'literal' | 'names' | 'permissions' | 'permission' | Domain

const PARAMETER_DEFINITIONS: Record<string, Record<string, string>> = {
    Agent: { description: 'label', prompt: 'task', subagent_type: 'agent_type' },
    AskUserQuestion: { questions: 'items', answers: 'responses', annotations: 'notes', metadata: 'context' },
    Bash: { command: 'script', timeout: 'timeout_ms', description: 'label', run_in_background: 'background', dangerouslyDisableSandbox: 'bypass_sandbox' },
    CronCreate: { cron: 'schedule', prompt: 'task', recurring: 'repeat', durable: 'persist' },
    CronDelete: { id: 'job_id' },
    CronList: {},
    Edit: { file_path: 'path', old_string: 'search', new_string: 'replacement', replace_all: 'all_matches' },
    EnterPlanMode: {},
    EnterWorktree: { name: 'workspace_name', path: 'workspace_path' },
    ExitPlanMode: { allowedPrompts: 'permissions' },
    ExitWorktree: { action: 'disposition', discard_changes: 'discard' },
    ListAgents: { channel: 'channel_filter', q: 'search' },
    NotebookEdit: { notebook_path: 'path', cell_id: 'cell', new_source: 'source', cell_type: 'kind', edit_mode: 'operation' },
    Read: { file_path: 'path', offset: 'start', limit: 'count', pages: 'page_range', allow_large: 'allow_oversize' },
    ReportFindings: { level: 'review_level', findings: 'issues' },
    ScheduleWakeup: { delaySeconds: 'delay_seconds', reason: 'reason', prompt: 'task', stop: 'stop', noop: 'unchanged' },
    SendMessage: { to: 'recipient', summary: 'label', message: 'body', notify_when_idle: 'when_idle' },
    Skill: { skill: 'name', args: 'arguments' },
    TaskStop: { task_id: 'id', shell_id: 'legacy_shell_id' },
    WebFetch: { url: 'url', prompt: 'instruction', offset: 'start' },
    WebSearch: { query: 'text', allowed_domains: 'include_domains', blocked_domains: 'exclude_domains' },
    Workflow: { script: 'source', name: 'workflow', description: 'description', title: 'title', args: 'input', scriptPath: 'source_path', resumeFromRunId: 'resume_id' },
    Write: { file_path: 'path', content: 'text' },
}

export const PARAMETER_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze(Object.fromEntries(
  Object.entries(PARAMETER_DEFINITIONS).map(([tool, aliases]) => [tool, Object.freeze(aliases)]),
))

const REVERSE_ALIASES = Object.freeze(Object.fromEntries(Object.entries(PARAMETER_ALIASES).map(([tool, aliases]) =>
  [tool, Object.freeze(Object.fromEntries(Object.entries(aliases).map(([native, wire]) => [wire, native])))],
)))

export function hasParameterAliases(nativeTool: string): boolean {
  return Object.hasOwn(PARAMETER_ALIASES, nativeTool) && Object.keys(PARAMETER_ALIASES[nativeTool]).length > 0
}

export function parameterKey(nativeTool: string, key: string, direction: Direction): string {
  const maps = direction === 'encode' ? PARAMETER_ALIASES : REVERSE_ALIASES
  if (!Object.hasOwn(maps, nativeTool)) return key
  const aliases = maps[nativeTool]
  return Object.hasOwn(aliases, key) ? aliases[key] : key
}

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

type Reject = (message: string) => never

export function renameInputKeys(input: RecordValue, key: (name: string) => string, reject: Reject): RecordValue {
  const entries: [string, unknown][] = []
  const seen = new Set<string>()
  let changed = false
  for (const [name, value] of Object.entries(input)) {
    const renamed = key(name)
    if (seen.has(renamed)) reject(`Parameter alias collision: ${name} -> ${renamed}`)
    seen.add(renamed)
    changed ||= renamed !== name
    entries.push([renamed, value])
  }
  return changed ? Object.fromEntries(entries) : input
}

interface SchemaCodec {
  encodeKey(key: string): string
  encodeSelector(domain: Domain, value: string): string
  decodeSelector(domain: Domain, value: string): string
  rewriteInstruction(text: string): string
  reject: Reject
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!record(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
}

const SAME_INSTANCE = new Set(['allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else'])
const CHILD_SCHEMA = new Set(['additionalProperties', 'unevaluatedProperties', 'contains', 'additionalItems', 'unevaluatedItems', 'contentSchema'])
const ANNOTATIONS = new Set(['description', 'title', '$comment'])
const STRING_CONSTRAINTS = new Set(['pattern', 'minLength', 'maxLength', 'format', 'contentEncoding', 'contentMediaType', 'contentSchema'])
const pointerPart = (value: string): string => value.replace(/~/g, '~0').replace(/\//g, '~1')
const childPointer = (pointer: string, key: string): string => `${pointer}/${pointerPart(key)}`

// Reference targets carry their instance context so a shared definition cannot acquire conflicting meanings.
export function encodeParameterSchema(nativeTool: string, schema: unknown, codec: SchemaCodec): unknown {
  if (!record(schema)) return schema
  const remapRoot = hasParameterAliases(nativeTool)
  const contexts = new Map<string, Context>()
  const nodes = new Map<string, unknown>()
  const moved = new Map<string, string>()
  const refs: { pointer: string; value: string }[] = []
  const resolving = new Set<string>()
  const rootNames = new Map<string, string>()
  const schemaLocations = new Set<string>()

  function index(value: unknown, pointer: string): void {
    if (!record(value) && typeof value !== 'boolean') return
    schemaLocations.add(pointer)
    if (!record(value)) return
    for (const [keyword, child] of Object.entries(value)) {
      const at = childPointer(pointer, keyword)
      if (['properties', 'patternProperties', '$defs', 'definitions', 'dependencies', 'dependentSchemas'].includes(keyword) && record(child)) {
        for (const [name, entry] of Object.entries(child)) index(entry, childPointer(at, name))
      } else if (SAME_INSTANCE.has(keyword) || CHILD_SCHEMA.has(keyword) || ['items', 'prefixItems', 'propertyNames'].includes(keyword)) {
        if (Array.isArray(child)) child.forEach((entry, i) => index(entry, childPointer(at, String(i))))
        else index(child, at)
      }
    }
  }
  index(schema, '#')

  function rootKey(name: string): string {
    const renamed = codec.encodeKey(name)
    const previous = rootNames.get(renamed)
    if (previous !== undefined && previous !== name) codec.reject(`Parameter alias collision: ${name} -> ${renamed}`)
    rootNames.set(renamed, name)
    return renamed
  }

  function selector(domain: Domain, value: string): string {
    if (codec.decodeSelector(domain, value) !== value) codec.reject(`Selector alias collision: ${value}`)
    return codec.encodeSelector(domain, value)
  }

  function literal(value: unknown, context: Context): unknown {
    if (context === 'names') return typeof value === 'string' ? rootKey(value) : value
    if (context === 'agent' || context === 'skill' || context === 'tool') return typeof value === 'string' ? selector(context, value) : value
    if (context === 'permissions' && Array.isArray(value)) return value.map(item => literal(item, 'permission'))
    if ((context === 'root' || context === 'permission') && record(value)) {
      const translated = Object.fromEntries(Object.entries(value).map(([name, item]) => [name, literal(item, propertyContext(context, name))]))
      return context === 'root' ? renameInputKeys(translated, rootKey, codec.reject) : translated
    }
    return value
  }

  function propertyContext(context: Context, name: string): Context {
    if (context === 'root') {
      if (nativeTool === 'Agent' && name === 'subagent_type') return 'agent'
      if (nativeTool === 'Skill' && name === 'skill') return 'skill'
      if (nativeTool === 'ExitPlanMode' && name === 'allowedPrompts') return 'permissions'
    }
    return context === 'permission' && name === 'tool' ? 'tool' : 'literal'
  }

  function names(value: unknown): unknown {
    if (!Array.isArray(value)) return value
    const seen = new Map<string, string>()
    return value.map(name => {
      if (typeof name !== 'string') return name
      const renamed = rootKey(name)
      const previous = seen.get(renamed)
      if (previous !== undefined && previous !== name) codec.reject(`Parameter alias collision: ${name} -> ${renamed}`)
      seen.set(renamed, name)
      return renamed
    }).sort((a, b) => typeof a === 'string' && typeof b === 'string' ? a < b ? -1 : a > b ? 1 : 0 : 0)
  }

  function resolve(ref: string, uriFragment = true): { pointer: string; value: unknown } {
    let fragment: string
    try { fragment = uriFragment ? decodeURIComponent(ref.slice(1)) : ref.slice(1) } catch { return codec.reject(`Invalid local schema reference: ${ref}`) }
    if (fragment && !fragment.startsWith('/')) return codec.reject(`Unsupported schema anchor reference: ${ref}`)
    let value: unknown = schema
    const parts = fragment ? fragment.slice(1).split('/') : []
    let pointer = '#'
    for (const part of parts) {
      if (/~(?:[^01]|$)/.test(part)) return codec.reject(`Invalid local schema reference: ${ref}`)
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
      if ((!record(value) && !Array.isArray(value)) || !Object.hasOwn(value, key)) return codec.reject(`Unresolved local schema reference: ${ref}`)
      value = (value as RecordValue)[key]
      pointer = childPointer(pointer, key)
    }
    return { pointer, value }
  }

  function walk(value: unknown, pointer: string, context: Context): unknown {
    if (!record(value)) return value
    const previous = contexts.get(pointer)
    if (previous !== undefined) {
      if (previous !== context) codec.reject(`Conflicting schema reference contexts at ${pointer}: ${previous} and ${context}`)
      return nodes.get(pointer)
    }
    contexts.set(pointer, context)
    const output: RecordValue = Object.create(null)
    nodes.set(pointer, output)
    if (remapRoot && pointer !== '#' && Object.hasOwn(value, '$id')) codec.reject(`Unsupported nested schema resource at ${pointer}`)
    if (remapRoot && (Object.hasOwn(value, '$dynamicRef') || Object.hasOwn(value, '$recursiveRef'))) codec.reject(`Unsupported dynamic schema reference at ${pointer}`)
    if (context === 'root' && record(value.patternProperties) && Object.keys(value.patternProperties).length) {
      codec.reject(`Unsupported root patternProperties at ${pointer}`)
    }
    for (const [keyword, child] of Object.entries(value)) {
      const at = childPointer(pointer, keyword)
      if ((context === 'names' || context === 'agent' || context === 'skill' || context === 'tool') && STRING_CONSTRAINTS.has(keyword)) {
        codec.reject(`Unsupported ${context === 'names' ? 'propertyNames' : 'selector'} constraint ${keyword} at ${pointer}`)
      }
      if (keyword === '$ref' && typeof child === 'string' && remapRoot) {
        if (!child.startsWith('#')) {
          if (context !== 'literal') codec.reject(`Unsupported external schema reference at ${pointer}`)
        } else {
          const target = resolve(child)
          if (!schemaLocations.has(target.pointer)) codec.reject(`Unsupported schema reference target: ${child}`)
          refs.push({ pointer: at, value: target.pointer })
          walk(target.value, target.pointer, context)
        }
        output[keyword] = child
      } else if (ANNOTATIONS.has(keyword) && typeof child === 'string') {
        output[keyword] = codec.rewriteInstruction(child)
      } else if (keyword === 'properties' && record(child)) {
        const entries = Object.entries(child).map(([name, property]) => {
          const renamed = context === 'root' ? rootKey(name) : name
          const from = childPointer(at, name)
          if (renamed !== name) moved.set(from, childPointer(at, renamed))
          return [renamed, walk(property, from, propertyContext(context, name))] as const
        })
        if (new Set(entries.map(([name]) => name)).size !== entries.length) codec.reject(`Parameter alias collision in properties at ${pointer}`)
        output[keyword] = Object.fromEntries(entries)
      } else if (keyword === 'required' && context === 'root') {
        output[keyword] = names(child)
      } else if (['dependencies', 'dependentRequired', 'dependentSchemas'].includes(keyword) && record(child)) {
        const entries = Object.entries(child).map(([name, dependency]) => {
          const renamed = context === 'root' ? rootKey(name) : name
          const from = childPointer(at, name)
          if (renamed !== name) moved.set(from, childPointer(at, renamed))
          const replacement = Array.isArray(dependency)
            ? context === 'root' ? names(dependency) : dependency
            : walk(dependency, from, context)
          return [renamed, replacement] as const
        })
        if (new Set(entries.map(([name]) => name)).size !== entries.length) codec.reject(`Parameter alias collision in ${keyword} at ${pointer}`)
        output[keyword] = Object.fromEntries(entries)
      } else if (keyword === 'propertyNames') {
        output[keyword] = walk(child, at, context === 'root' ? 'names' : 'literal')
      } else if (SAME_INSTANCE.has(keyword)) {
        output[keyword] = Array.isArray(child)
          ? child.map((entry, index) => walk(entry, childPointer(at, String(index)), context))
          : walk(child, at, context)
      } else if (keyword === 'items' || keyword === 'prefixItems') {
        const itemContext = context === 'permissions' ? 'permission' : 'literal'
        output[keyword] = Array.isArray(child)
          ? child.map((entry, index) => walk(entry, childPointer(at, String(index)), itemContext))
          : walk(child, at, itemContext)
      } else if (CHILD_SCHEMA.has(keyword)) {
        output[keyword] = walk(child, at, 'literal')
      } else if (keyword === 'patternProperties' && record(child)) {
        output[keyword] = Object.fromEntries(Object.entries(child).map(([name, entry]) => [name, walk(entry, childPointer(at, name), 'literal')]))
      } else if (keyword === '$defs' || keyword === 'definitions') {
        // Definitions are visited after references have assigned their instance contexts.
        output[keyword] = child
      } else if ((keyword === 'enum' || keyword === 'examples') && Array.isArray(child)) {
        output[keyword] = context === 'names' && keyword === 'enum' ? names(child) : child.map(item => literal(item, context))
      } else if (keyword === 'const' || keyword === 'default') {
        output[keyword] = literal(child, context)
      } else {
        output[keyword] = child
      }
    }
    return output
  }

  walk(schema, '#', remapRoot ? 'root' : 'literal')

  function finish(value: unknown, pointer: string): unknown {
    if (!record(value)) return value
    if (resolving.has(pointer)) return nodes.get(pointer)
    resolving.add(pointer)
    const output = (nodes.get(pointer) ?? walk(value, pointer, 'literal')) as RecordValue
    for (const keyword of ['$defs', 'definitions']) {
      const definitions = value[keyword]
      if (record(definitions)) {
        output[keyword] = Object.fromEntries(Object.entries(definitions).map(([name, definition]) => {
          const at = childPointer(childPointer(pointer, keyword), name)
          if (!contexts.has(at)) walk(definition, at, 'literal')
          return [name, finish(definition, at)]
        }))
      }
    }
    return output
  }

  // A definition may itself contain more definitions, including inside an applicator.
  for (const [pointer] of contexts) finish(resolve(pointer, false).value, pointer)
  for (const ref of refs) {
    const split = ref.pointer.lastIndexOf('/')
    const output = nodes.get(ref.pointer.slice(0, split)) as RecordValue
    let target = ref.value
    const replacements = [...moved].filter(([from]) => target === from || target.startsWith(from + '/')).sort(([a], [b]) => b.length - a.length)
    for (const [from, to] of replacements) target = to + target.slice(from.length)
    output.$ref = '#' + encodeURI(target.slice(1)).replace(/#/g, '%23')
  }
  return canonical(nodes.get('#'))
}
