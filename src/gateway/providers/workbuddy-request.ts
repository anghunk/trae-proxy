import { createHash, randomBytes, randomUUID } from 'node:crypto'

/**
 * WorkBuddy 请求归一化与响应回写。
 *
 * WorkBuddy 的对话接口只接受自己客户端的请求形态：
 * - 必须 `stream: true`（非流式直接 400 code 11101）；
 * - 只认 `max_tokens`，不认 OpenAI 客户端的 `max_completion_tokens`；
 * - 只认 `system`，不认 `developer`；
 * - `tool_choice` 只写字符串形式；
 * - 参数 schema 必须是根为 object 的 JSON Schema，且 `enum` 要带类型，
 *   否则部分模型（DeepSeek / Kimi）直接 400 code 11133；
 * - 工具名只允许 `[A-Za-z0-9_-]`。
 *
 * 另外 WorkBuddy 会拒绝对话里出现 Codex / Claude Code 的提示词特征
 * （code 11128「unapproved channel」），这里按参考实现做等价改写。
 *
 * 归一化规则参考 magpie-community/plugins 的 workbuddy 插件。
 *
 * @module trae-proxy/gateway/providers/workbuddy-request
 */

/** 进程内随机盐，让派生出的对话 / 轮次 id 不泄露消息原文。 */
const ID_SALT = randomBytes(16).toString('hex')

/** 归一化后的请求体与需要回写的工具名映射（安全名 → 调用方原名）。 */
export interface NormalizedRequest {
  body: string
  /** 安全化后的工具名映射；为空表示没有工具名被改写。 */
  toolNames: Map<string, string>
  /** 本次请求对应的对话 / 轮次标识。 */
  turn: WorkbuddyTurnIds
}

/**
 * WorkBuddy 对话 / 轮次标识。
 *
 * 上游按 `X-Conversation-Request-ID` 统计“一次用户发送”，同一轮的
 * 重试与工具回传必须复用同一个值，用户下一条消息换成新值。
 */
export interface WorkbuddyTurnIds {
  /** 对话 id；无法确定对话时为空（此时不发送）。 */
  conversationId?: string
  /** 本轮 id；总是存在。 */
  requestId: string
}

/** WorkBuddy 拒绝的提示词特征，替换为等价但不触发拦截的写法。 */
const FLAGGED: ReadonlyArray<readonly [RegExp, string]> = [
  [/x-anthropic-billing-header:[^\n]*\n?/gi, ''],
  [/You are Claude Code, Anthropic['’]s official CLI for Claude/gi, "You are Claude Code, Anthropic's CLI for Claude"],
  [/Main branch \(you will usually use this for PRs\)/gi, 'Main branch (usually the base for PRs)'],
  [/(?<!the )Codex CLI is an open source project led by OpenAI\./gi, 'The Codex CLI is an open source project led by OpenAI.'],
]

const NAME_OK = /^[A-Za-z0-9_-]+$/
const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])
/** 值是单个子 schema 的关键字。 */
const SUB_ONE = ['items', 'additionalItems', 'unevaluatedItems', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'additionalProperties', 'unevaluatedProperties']
/** 值是子 schema 数组的关键字。 */
const SUB_LIST = ['anyOf', 'oneOf', 'allOf', 'prefixItems']
/** 值是「名字 → 子 schema」映射的关键字。 */
const SUB_MAP = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']
/** 允许直接是布尔值的子 schema 关键字。 */
const BOOL_OK = new Set(['additionalProperties', 'unevaluatedProperties'])
/** 嵌套遍历的深度上限，防御畸形 schema。 */
const MAX_DEPTH = 64

/** 改写文本里会触发 WorkBuddy 渠道校验的片段。 */
function unflagged(text: string): string {
  let out = text
  for (const [pattern, replacement] of FLAGGED) out = out.replace(pattern, replacement)
  return out
}

/** 就地清洗 chat 里的提示词特征；返回是否有改动。 */
function unflagMessages(messages: unknown[]): boolean {
  let changed = false
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (typeof message !== 'object' || message === null) continue
    const record = message as Record<string, unknown>
    const content = record['content']
    if (typeof content === 'string') {
      const next = unflagged(content)
      if (next === content) continue
      changed = true
      if (next.trim() !== '' || record['role'] !== 'system') record['content'] = next
      else messages.splice(index, 1)
      continue
    }
    if (!Array.isArray(content)) continue
    const parts: unknown[] = []
    let touched = false
    for (const part of content) {
      if (typeof part !== 'object' || part === null) {
        parts.push(part)
        continue
      }
      const text = (part as Record<string, unknown>)['text']
      if (typeof text !== 'string') {
        parts.push(part)
        continue
      }
      const next = unflagged(text)
      if (next === text) {
        parts.push(part)
        continue
      }
      touched = true
      if (next.trim() !== '') parts.push({ ...part, text: next })
    }
    if (!touched) continue
    changed = true
    if (parts.length > 0 || record['role'] !== 'system') record['content'] = parts
    else messages.splice(index, 1)
  }
  return changed
}

/** schema 的 `enum` 值对应的 JSON 类型。 */
function valueType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

/**
 * 给 `enum` 补上类型。
 *
 * Kimi / DeepSeek 会拒绝没有 `type` 的枚举；多类型枚举拆成 `anyOf`。
 */
function fitEnum(schema: Record<string, unknown>): boolean {
  if (!('enum' in schema)) return false
  const values = schema['enum']
  if (!Array.isArray(values) || values.length === 0) {
    delete schema['enum']
    return true
  }
  const declared = Array.isArray(schema['type'])
    ? schema['type']
    : typeof schema['type'] === 'string' ? [schema['type']] : []
  if (declared.filter(item => item !== 'null').length === 1) return false
  const grouped = new Map<string, unknown[]>()
  for (const value of values) {
    const type = valueType(value)
    const bucket = grouped.get(type)
    if (bucket === undefined) grouped.set(type, [value])
    else bucket.push(value)
  }
  // integer 与 number 合并到 number，避免拆出两个语义重叠的分支
  const integers = grouped.get('integer')
  if (integers !== undefined && grouped.has('number')) grouped.get('number')!.push(...integers)
  if (integers !== undefined) grouped.delete('integer')
  const hasNull = grouped.delete('null')
  if (grouped.size <= 1) {
    const [type] = grouped.keys()
    const want = type === undefined ? 'null' : hasNull ? [type, 'null'] : type
    if (JSON.stringify(want) === JSON.stringify(schema['type'])) return false
    schema['type'] = want
    return true
  }
  const branches: Array<Record<string, unknown>> = [...grouped].map(([type, items]) => ({ type, enum: items }))
  if (hasNull) branches.push({ type: 'null' })
  delete schema['enum']
  delete schema['type']
  if (Array.isArray(schema['anyOf'])) {
    schema['allOf'] = [...Array.isArray(schema['allOf']) ? schema['allOf'] : [], { anyOf: branches }]
  } else {
    schema['anyOf'] = branches
  }
  return true
}

/** 布尔子 schema 归一化：`true` → `{}`，`false` → `{"not": {}}`。 */
function subSchema(value: unknown, key: string): unknown {
  if (typeof value !== 'boolean' || BOOL_OK.has(key)) return value
  return value ? {} : { not: {} }
}

/** 就地修补 schema 的类型、`required` 与 `enum`。 */
function fitShape(schema: unknown, depth = 0): boolean {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema) || depth > MAX_DEPTH) return false
  const record = schema as Record<string, unknown>
  let changed = false
  if ('type' in record) {
    const list = (Array.isArray(record['type']) ? record['type'] : [record['type']])
      .map(item => typeof item === 'string' ? item.toLowerCase() : item)
      .filter(item => typeof item === 'string' && SCHEMA_TYPES.has(item))
    const unique = [...new Set(list)]
    const want = unique.length === 0 ? undefined : unique.length === 1 ? unique[0] : unique
    if (JSON.stringify(want) !== JSON.stringify(record['type'])) {
      if (want === undefined) delete record['type']
      else record['type'] = want
      changed = true
    }
  }
  if ('required' in record && !Array.isArray(record['required'])) {
    delete record['required']
    changed = true
  } else if (Array.isArray(record['required']) && record['required'].some(item => typeof item !== 'string')) {
    record['required'] = record['required'].filter(item => typeof item === 'string')
    changed = true
  }
  if (fitEnum(record)) changed = true
  for (const key of SUB_ONE) {
    if (!(key in record)) continue
    const value = subSchema(record[key], key)
    if (value !== record[key]) {
      record[key] = value
      changed = true
    }
    if (fitShape(value, depth + 1)) changed = true
  }
  for (const key of SUB_LIST) {
    const list = record[key]
    if (!Array.isArray(list)) continue
    for (let index = 0; index < list.length; index += 1) {
      const value = subSchema(list[index], key)
      if (value !== list[index]) {
        list[index] = value
        changed = true
      }
      if (fitShape(value, depth + 1)) changed = true
    }
  }
  for (const key of SUB_MAP) {
    const map = record[key]
    if (typeof map !== 'object' || map === null || Array.isArray(map)) continue
    for (const [name, raw] of Object.entries(map as Record<string, unknown>)) {
      const value = subSchema(raw, key)
      if (value !== raw) {
        (map as Record<string, unknown>)[name] = value
        changed = true
      }
      if (fitShape(value, depth + 1)) changed = true
    }
  }
  return changed
}

/**
 * 处理 DeepSeek 校验器不接受的具体写法。
 *
 * 正则里的 `\0`（NUL）会被判为非法正则，改写成等价的 `\u0000`；
 * tuple 形式的 `items`（数组）合并成一个 `anyOf` schema。
 */
function fitSchema(schema: unknown, depth = 0): boolean {
  if (typeof schema !== 'object' || schema === null || depth > MAX_DEPTH) return false
  if (Array.isArray(schema)) {
    let changed = false
    for (const item of schema) if (fitSchema(item, depth + 1)) changed = true
    return changed
  }
  const record = schema as Record<string, unknown>
  let changed = false
  const pattern = record['pattern']
  if (typeof pattern === 'string' && pattern.includes('\\0')) {
    // 保留 `\\0`（转义反斜杠），只替换真正的 NUL 转义
    const next = pattern.replace(/\\\\|\\0(?![0-9])/g, match => match === '\\\\' ? match : '\\u0000')
    if (next !== pattern) {
      record['pattern'] = next
      changed = true
    }
  }
  if (Array.isArray(record['items'])) {
    const list = record['items'].filter(item => typeof item === 'object' && item !== null)
    record['items'] = list.length === 0 ? {} : list.length === 1 ? list[0] : { anyOf: list }
    delete record['additionalItems']
    changed = true
  }
  for (const value of Object.values(record)) if (fitSchema(value, depth + 1)) changed = true
  return changed
}

/** 解析本地 `$ref`（`#/...`）指向的 schema。 */
function localRef(root: unknown, schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null) return schema
  const ref = (schema as Record<string, unknown>)['$ref']
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return schema
  let at: unknown = root
  for (const key of ref.slice(2).split('/')) {
    if (typeof at !== 'object' || at === null) return schema
    at = (at as Record<string, unknown>)[key.replaceAll('~1', '/').replaceAll('~0', '~')]
  }
  return typeof at === 'object' && at !== null ? at : schema
}

/**
 * 把工具参数 schema 的根变成 object。
 *
 * WorkBuddy 只接受根为 object 的参数；根上的 `anyOf` / `oneOf` / `allOf`
 * 会合并成一份属性表，任何一支都要求的字段保留为 required。
 */
function objectRoot(schema: Record<string, unknown>, root: unknown = schema, depth = 0): boolean {
  const unions = ['allOf', 'anyOf', 'oneOf'].filter(key => Array.isArray(schema[key]))
  if (schema['type'] === 'object' && unions.length === 0) return false
  const properties = typeof schema['properties'] === 'object' && schema['properties'] !== null
    ? schema['properties'] as Record<string, unknown>
    : {}
  const required = Array.isArray(schema['required']) ? [...schema['required']] as unknown[] : []
  for (const raw of Array.isArray(schema['allOf']) ? schema['allOf'] : []) {
    let branch = localRef(root, raw)
    if (typeof branch !== 'object' || branch === null) continue
    if (depth < 8 && ['allOf', 'anyOf', 'oneOf'].some(key => Array.isArray((branch as Record<string, unknown>)[key]))) {
      branch = structuredClone(branch)
      objectRoot(branch as Record<string, unknown>, root, depth + 1)
    }
    const record = branch as Record<string, unknown>
    for (const [key, value] of Object.entries(typeof record['properties'] === 'object' && record['properties'] !== null ? record['properties'] as Record<string, unknown> : {})) {
      if (!(key in properties)) properties[key] = value
    }
    if (Array.isArray(record['required'])) required.push(...record['required'])
  }
  const branches: Array<Record<string, unknown>> = []
  for (const key of ['anyOf', 'oneOf']) {
    for (const raw of Array.isArray(schema[key]) ? schema[key] as unknown[] : []) {
      let branch = localRef(root, raw)
      if (typeof branch !== 'object' || branch === null) continue
      if (depth < 8 && ['allOf', 'anyOf', 'oneOf'].some(item => Array.isArray((branch as Record<string, unknown>)[item]))) {
        branch = structuredClone(branch)
        objectRoot(branch as Record<string, unknown>, root, depth + 1)
      }
      const record = branch as Record<string, unknown>
      if (record['type'] !== 'object' && record['properties'] === undefined) continue
      branches.push(record)
    }
  }
  const alternatives = new Map<string, unknown[]>()
  for (const branch of branches) {
    for (const [key, value] of Object.entries(typeof branch['properties'] === 'object' && branch['properties'] !== null ? branch['properties'] as Record<string, unknown> : {})) {
      if (key in properties) continue
      const seen = alternatives.get(key) ?? []
      if (!seen.some(item => JSON.stringify(item) === JSON.stringify(value))) seen.push(value)
      alternatives.set(key, seen)
    }
  }
  for (const [key, list] of alternatives) properties[key] = list.length === 1 ? list[0] : { anyOf: list }
  if (branches.length > 0 && branches[0] !== undefined) {
    for (const key of Object.keys(typeof branches[0]['properties'] === 'object' && branches[0]['properties'] !== null ? branches[0]['properties'] as Record<string, unknown> : {})) {
      if (branches.every(branch => Array.isArray(branch['required']) && branch['required'].includes(key))) required.push(key)
    }
  }
  for (const key of unions) delete schema[key]
  schema['type'] = 'object'
  schema['properties'] = properties
  const kept = [...new Set(required)].filter((key): key is string => typeof key === 'string' && key in properties)
  if (kept.length > 0) schema['required'] = kept
  else delete schema['required']
  return true
}

/**
 * 修补 chat 里的 function 工具，并记录被安全化的工具名。
 *
 * @returns 安全名 → 调用方原名；空 Map 表示没有改名。
 */
function fitTools(chat: Record<string, unknown>): Map<string, string> {
  const names = new Map<string, string>()
  const tools = chat['tools']
  if (!Array.isArray(tools) || tools.length === 0) return names
  const taken = new Set<string>()
  for (const tool of tools) {
    const name = typeof tool === 'object' && tool !== null
      ? (tool as Record<string, unknown>)['function'] instanceof Object
        ? ((tool as Record<string, unknown>)['function'] as Record<string, unknown>)['name']
        : undefined
      : undefined
    if (typeof name === 'string' && NAME_OK.test(name)) taken.add(name)
  }
  const renamed = new Map<string, string>()
  for (const tool of tools) {
    if (typeof tool !== 'object' || tool === null) continue
    const record = tool as Record<string, unknown>
    const fn = typeof record['function'] === 'object' && record['function'] !== null
      ? record['function'] as Record<string, unknown>
      : undefined
    if (fn === undefined) continue
    const name = fn['name']
    if (typeof name === 'string' && name !== '' && !NAME_OK.test(name)) {
      const base = name.replace(/[^A-Za-z0-9_-]/g, '_') || 'tool'
      let safe = base
      for (let index = 2; taken.has(safe); index += 1) safe = `${base}_${index}`
      taken.add(safe)
      names.set(safe, name)
      renamed.set(name, safe)
      fn['name'] = safe
    }
    const parameters = fn['parameters']
    if (parameters === undefined) continue
    if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
      fn['parameters'] = { type: 'object', properties: {} }
      continue
    }
    fitSchema(parameters)
    fitShape(parameters)
    objectRoot(parameters as Record<string, unknown>)
  }
  if (renamed.size > 0) {
    const messages = Array.isArray(chat['messages']) ? chat['messages'] : []
    for (const message of messages) {
      if (typeof message !== 'object' || message === null) continue
      const record = message as Record<string, unknown>
      for (const call of Array.isArray(record['tool_calls']) ? record['tool_calls'] as unknown[] : []) {
        if (typeof call !== 'object' || call === null) continue
        const fn = (call as Record<string, unknown>)['function']
        if (typeof fn !== 'object' || fn === null) continue
        const name = (fn as Record<string, unknown>)['name']
        const safe = typeof name === 'string' ? renamed.get(name) : undefined
        if (safe !== undefined) (fn as Record<string, unknown>)['name'] = safe
      }
      const toolName = record['name']
      const safe = typeof toolName === 'string' ? renamed.get(toolName) : undefined
      if (record['role'] === 'tool' && safe !== undefined) record['name'] = safe
    }
    const choice = chat['tool_choice']
    if (typeof choice === 'object' && choice !== null) {
      const fn = (choice as Record<string, unknown>)['function']
      if (typeof fn === 'object' && fn !== null) {
        const name = (fn as Record<string, unknown>)['name']
        const safe = typeof name === 'string' ? renamed.get(name) : undefined
        if (safe !== undefined) (fn as Record<string, unknown>)['name'] = safe
      }
    }
  }
  return names
}

/** `tool_choice` 的对象写法转成 WorkBuddy 接受的字符串写法。 */
function normalizeToolChoice(chat: Record<string, unknown>): void {
  if (!('tool_choice' in chat)) return
  const choice = chat['tool_choice']
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete chat['tool_choice']
      delete chat['tools']
      delete chat['functions']
    }
    return
  }
  if (typeof choice !== 'object' || choice === null || Array.isArray(choice)) {
    delete chat['tool_choice']
    return
  }
  const record = choice as Record<string, unknown>
  const type = typeof record['type'] === 'string' ? record['type'].trim().toLowerCase() : ''
  if (type === 'none') {
    delete chat['tool_choice']
    delete chat['tools']
    delete chat['functions']
  } else if (type === 'auto' || type === 'required') {
    chat['tool_choice'] = type
  } else if (type === 'function') {
    const fn = typeof record['function'] === 'object' && record['function'] !== null
      ? record['function'] as Record<string, unknown>
      : undefined
    const name = typeof fn?.['name'] === 'string' ? fn['name'].trim() : ''
    chat['tool_choice'] = name === '' ? 'auto' : name
  } else {
    delete chat['tool_choice']
  }
}

/**
 * 归一化一次 WorkBuddy 对话请求。
 *
 * @param bodyJson 入站 OpenAI chat/completions 请求体。
 * @param defaultEffort 模型声明的默认推理档位；上游对部分模型要求显式指定。
 * @param sessionId 网关注入的会话标识；用于派生更稳定的对话 id。
 */
export function normalizeWorkbuddyRequest(bodyJson: string, defaultEffort?: string, sessionId?: string): NormalizedRequest {
  let chat: Record<string, unknown>
  try {
    const parsed = JSON.parse(bodyJson) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { body: bodyJson, toolNames: new Map(), turn: { requestId: randomUUID().replaceAll('-', '') } }
    }
    chat = parsed as Record<string, unknown>
  } catch {
    return { body: bodyJson, toolNames: new Map(), turn: { requestId: randomUUID().replaceAll('-', '') } }
  }
  const toolNames = fitTools(chat)
  const messages = Array.isArray(chat['messages']) ? chat['messages'] as unknown[] : []
  if (messages.length > 0) {
    unflagMessages(messages)
    // developer 是 OpenAI 新写法，WorkBuddy 只认 system
    for (const message of messages) {
      if (typeof message === 'object' && message !== null && (message as Record<string, unknown>)['role'] === 'developer') {
        (message as Record<string, unknown>)['role'] = 'system'
      }
    }
    const first = messages[0]
    if (typeof first !== 'object' || first === null || (first as Record<string, unknown>)['role'] !== 'system') {
      messages.unshift({ role: 'system', content: 'You are a helpful assistant.' })
    }
  }
  // 上游拒绝非流式请求（code 11101），统一以流式发起，由调用方决定是否本地聚合
  chat['stream'] = true
  delete chat['stream_options']
  chat['stream_options'] = { include_usage: true }
  if (chat['max_completion_tokens'] !== undefined) {
    if (chat['max_tokens'] === undefined) chat['max_tokens'] = chat['max_completion_tokens']
    delete chat['max_completion_tokens']
  }
  normalizeToolChoice(chat)
  const effort = chat['reasoning_effort']
  if (typeof effort !== 'string' || effort.trim() === '') {
    if (defaultEffort !== undefined && defaultEffort !== '') chat['reasoning_effort'] = defaultEffort
    else delete chat['reasoning_effort']
  }
  return { body: JSON.stringify(chat), toolNames, turn: turnIds(chat, sessionId) }
}

/** 用回合名派生 32 位十六进制 id，让 id 本身不泄露消息原文。 */
function hexId(kind: string, key: string): string {
  return createHash('sha256').update(`${ID_SALT}|${kind}|${key}`).digest('hex').slice(0, 32)
}

/** 取消息内容里“属于用户本人”的文本特征。 */
function contentSignature(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue
    const record = part as Record<string, unknown>
    const type = typeof record['type'] === 'string' ? record['type'] : ''
    if (type === '' || type === 'text') {
      if (typeof record['text'] === 'string') out += record['text']
    } else if (type !== 'tool_result' && type !== 'tool-result') {
      // 图片、文件等非文本部分用摘要占位，保证只有图片的一轮也能区分
      out += `[${type}:${createHash('sha256').update(JSON.stringify(part)).digest('hex').slice(0, 8)}]`
    }
  }
  return out
}

/** 判断某条消息是否在回传上一步的结果，而不是用户自己说的话。 */
function answeredBefore(messages: unknown[], index: number): boolean {
  const previous = messages[index - 1]
  if (typeof previous !== 'object' || previous === null) return false
  const record = previous as Record<string, unknown>
  if (record['role'] === 'tool') return true
  return record['role'] === 'assistant'
    && Array.isArray(record['tool_calls'])
    && record['tool_calls'].length > 0
}

/**
 * 派生对话与轮次标识。
 *
 * 对话标识优先取网关注入的会话名，其次取首条用户消息；轮次标识取最后一条
 * “用户本人”的消息。两者一致时同一轮的重试与工具回传会复用同一个请求 id，
 * 用户下一条消息则自动换新，符合 WorkBuddy 自己的统计口径。
 */
function turnIds(chat: Record<string, unknown>, sessionId?: string): WorkbuddyTurnIds {
  const messages = Array.isArray(chat['messages']) ? chat['messages'] : []
  let conversationKey = typeof sessionId === 'string' && sessionId !== '' ? `session:${sessionId.slice(0, 128)}` : ''
  if (conversationKey === '') {
    for (const message of messages) {
      if (typeof message !== 'object' || message === null) continue
      const record = message as Record<string, unknown>
      if (record['role'] !== 'user') continue
      const signature = contentSignature(record['content'])
      if (signature !== '') {
        conversationKey = `first:${signature}`
        break
      }
    }
  }
  let turnKey = ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (typeof message !== 'object' || message === null) continue
    const record = message as Record<string, unknown>
    if (record['role'] !== 'user' || answeredBefore(messages, index)) continue
    const signature = contentSignature(record['content'])
    if (signature !== '') turnKey = `u${index}:${signature}`
    break
  }
  const conversationId = conversationKey === '' ? undefined : hexId('conversation', conversationKey)
  return {
    ...conversationId === undefined ? {} : { conversationId },
    requestId: turnKey === '' ? randomUUID().replaceAll('-', '') : hexId('turn', `${conversationKey}|${turnKey}`),
  }
}

/** 把模型返回的工具名改回调用方使用的名字。 */
function renameCalls(value: unknown, toolNames: Map<string, string>): boolean {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  let changed = false
  for (const choice of Array.isArray(record['choices']) ? record['choices'] as unknown[] : []) {
    if (typeof choice !== 'object' || choice === null) continue
    const choiceRecord = choice as Record<string, unknown>
    for (const key of ['message', 'delta']) {
      const payload = choiceRecord[key]
      if (typeof payload !== 'object' || payload === null) continue
      for (const call of Array.isArray((payload as Record<string, unknown>)['tool_calls']) ? (payload as Record<string, unknown>)['tool_calls'] as unknown[] : []) {
        if (typeof call !== 'object' || call === null) continue
        const fn = (call as Record<string, unknown>)['function']
        if (typeof fn !== 'object' || fn === null) continue
        const name = (fn as Record<string, unknown>)['name']
        const original = typeof name === 'string' ? toolNames.get(name) : undefined
        if (original !== undefined) {
          (fn as Record<string, unknown>)['name'] = original
          changed = true
        }
      }
    }
  }
  return changed
}

/**
 * 包装上游 SSE 响应，把工具名改回调用方的写法。
 *
 * 只改写 `data:` 行，行分隔与空行保持原样；没有改名时直接返回原响应。
 */
export function restoreToolNames(response: Response, toolNames: Map<string, string>): Response {
  if (toolNames.size === 0 || response.body === null) return response
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  const rewriteLine = (line: string): string => {
    if (!line.startsWith('data:')) return line
    const data = line.slice(5).trim()
    if (data === '' || data === '[DONE]') return line
    let parsed: unknown
    try {
      parsed = JSON.parse(data) as unknown
    } catch {
      return line
    }
    return renameCalls(parsed, toolNames) ? `data: ${JSON.stringify(parsed)}` : line
  }
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      if (lines.length > 0) controller.enqueue(encoder.encode(`${lines.map(rewriteLine).join('\n')}\n`))
    },
    flush(controller) {
      buffer += decoder.decode()
      if (buffer !== '') controller.enqueue(encoder.encode(rewriteLine(buffer)))
    },
  }))
  // 上游响应的 Content-Encoding / Content-Length 描述的是压缩前字节流；
  // fetch 已解压，包装后的 body 长度不同，必须去掉以免下游解析失败。
  const headers = new Headers(response.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

