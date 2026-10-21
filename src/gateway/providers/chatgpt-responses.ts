/**
 * Chat Completions ↔ Responses 协议桥。
 *
 * 网关的 Provider 接口以 Chat Completions 为统一入站格式，而 ChatGPT
 * 订阅额度只能调用 Responses API。本模块负责：
 * - 把聊天消息、图片与函数工具转换为 Responses input items；
 * - 去掉订阅路由不支持的采样参数；
 * - 把 Responses 语义化 SSE 事件转换为 Chat Completions chunk。
 *
 * @module trae-proxy/gateway/providers/chatgpt-responses
 */

import { randomUUID } from 'node:crypto'

/** 单一命名空间用于满足订阅路由对函数工具的约束。 */
export const CHATGPT_TOOL_NAMESPACE = 'trae_proxy'

interface ChatToolState {
  index: number
  id: string
  name: string
  argumentsSent: string
  added: boolean
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const rawPart of content) {
    const part = objectValue(rawPart)
    if (part === undefined) continue
    const text = stringValue(part['text'])
    if (text !== undefined) parts.push(text)
  }
  return parts.join('')
}

function messageContent(content: unknown): unknown {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: Record<string, unknown>[] = []
  for (const rawPart of content) {
    const part = objectValue(rawPart)
    if (part === undefined) continue
    const type = stringValue(part['type'])
    if (type === 'text' || type === 'input_text') {
      const text = stringValue(part['text'])
      if (text !== undefined) parts.push({ type: 'input_text', text })
      continue
    }
    if (type === 'image_url' || type === 'input_image') {
      const image = objectValue(part['image_url'])
      const imageUrl = stringValue(image?.['url']) ?? stringValue(part['image_url']) ?? stringValue(part['file_id'])
      if (imageUrl !== undefined) {
        const detail = stringValue(image?.['detail']) ?? stringValue(part['detail'])
        parts.push({
          type: 'input_image',
          image_url: imageUrl,
          ...detail === undefined ? {} : { detail },
        })
      }
      continue
    }
    if (type === 'file' || type === 'input_file') {
      const file = objectValue(part['file'])
      const filename = stringValue(file?.['filename']) ?? stringValue(part['filename'])
      const fileData = stringValue(file?.['file_data']) ?? stringValue(part['file_data'])
      const fileId = stringValue(file?.['file_id']) ?? stringValue(part['file_id'])
      parts.push({
        type: 'input_file',
        ...filename === undefined ? {} : { filename },
        ...fileData === undefined ? {} : { file_data: fileData },
        ...fileId === undefined ? {} : { file_id: fileId },
      })
    }
  }
  return parts
}

function functionTool(raw: unknown): Record<string, unknown> | undefined {
  const tool = objectValue(raw)
  if (tool === undefined) return undefined
  const type = stringValue(tool['type'])
  if (type === 'function') {
    const fn = objectValue(tool['function'])
    const source = fn ?? tool
    const name = stringValue(source['name'])
    if (name === undefined || name === '') return undefined
    return {
      type: 'function',
      name,
      ...stringValue(source['description']) === undefined ? {} : { description: source['description'] },
      ...objectValue(source['parameters']) === undefined ? {} : { parameters: source['parameters'] },
      ...typeof source['strict'] === 'boolean' ? { strict: source['strict'] } : { strict: false },
    }
  }
  if (type === 'custom') {
    const custom = objectValue(tool['custom'])
    const source = custom ?? tool
    const name = stringValue(source['name'])
    if (name === undefined || name === '') return undefined
    return {
      type: 'custom',
      name,
      ...stringValue(source['description']) === undefined ? {} : { description: source['description'] },
      ...objectValue(source['format']) === undefined ? {} : { format: source['format'] },
    }
  }
  const name = stringValue(tool['name'])
  if (name !== undefined && name !== '') {
    return {
      type: 'function',
      name,
      ...stringValue(tool['description']) === undefined ? {} : { description: tool['description'] },
      ...objectValue(tool['parameters']) === undefined ? {} : { parameters: tool['parameters'] },
      ...typeof tool['strict'] === 'boolean' ? { strict: tool['strict'] } : { strict: false },
    }
  }
  return undefined
}

function convertTools(tools: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(tools)) return undefined
  const converted = tools.map(functionTool).filter((tool): tool is Record<string, unknown> => tool !== undefined)
  if (converted.length === 0) return undefined
  return [{
    type: 'namespace',
    name: CHATGPT_TOOL_NAMESPACE,
    description: 'Tools provided by the local trae-proxy gateway.',
    tools: converted,
  }]
}

function convertToolChoice(value: unknown): unknown {
  if (value === 'auto' || value === 'none' || value === 'required') return value
  const choice = objectValue(value)
  if (choice === undefined) return undefined
  const type = stringValue(choice['type'])
  const nested = objectValue(choice['function']) ?? objectValue(choice['custom'])
  const name = stringValue(nested?.['name'])
  if (name === undefined || name === '') return undefined
  return {
    type: type === 'custom' ? 'custom' : 'function',
    name,
  }
}

function convertResponseFormat(value: unknown): Record<string, unknown> | undefined {
  const format = objectValue(value)
  if (format === undefined) return undefined
  const type = stringValue(format['type'])
  if (type === 'json_object') return { type: 'json_object' }
  if (type !== 'json_schema') return undefined
  const schema = objectValue(format['json_schema'])
  const name = stringValue(schema?.['name'])
  const jsonSchema = objectValue(schema?.['schema'])
  if (name === undefined || jsonSchema === undefined) return undefined
  return {
    type: 'json_schema',
    name,
    schema: jsonSchema,
    ...stringValue(schema?.['description']) === undefined ? {} : { description: schema?.['description'] },
    ...typeof schema?.['strict'] === 'boolean' ? { strict: schema['strict'] } : {},
  }
}

/**
 * 把网关收到的 Chat Completions 请求转换成订阅路由允许的 Responses 请求。
 *
 * 订阅路由只允许公开 `/v1/responses`，并强制 `store: false`、`stream: true`。
 * 温度、top_p、max_output_tokens 等字段在该路由不受支持，因此这里主动省略。
 */
export function chatRequestToResponses(input: Record<string, unknown>): Record<string, unknown> {
  const model = stringValue(input['model']) ?? ''
  if (model === '') throw new Error('缺少 model')
  const messages = Array.isArray(input['messages']) ? input['messages'] : []
  if (messages.length === 0) throw new Error('messages 不能为空')

  const instructions: string[] = []
  const items: Record<string, unknown>[] = []
  for (const rawMessage of messages) {
    const message = objectValue(rawMessage)
    if (message === undefined) continue
    const role = stringValue(message['role']) ?? ''
    const content = message['content']
    if (role === 'system' || role === 'developer') {
      const text = messageText(content)
      if (text !== '') instructions.push(text)
      continue
    }
    if (role === 'tool' || role === 'function') {
      const callId = stringValue(message['tool_call_id'])
        ?? stringValue(message['call_id'])
        ?? stringValue(message['name'])
        ?? `call_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      items.push({
        type: 'function_call_output',
        call_id: callId,
        output: messageText(content),
        namespace: CHATGPT_TOOL_NAMESPACE,
      })
      continue
    }
    if (role === 'assistant') {
      const text = messageText(content)
      if (text !== '') items.push({ role: 'assistant', content: text })
      const toolCalls = Array.isArray(message['tool_calls']) ? message['tool_calls'] : []
      for (const rawCall of toolCalls) {
        const call = objectValue(rawCall)
        const fn = objectValue(call?.['function'])
        const name = stringValue(fn?.['name'])
        if (call === undefined || fn === undefined || name === undefined) continue
        items.push({
          type: 'function_call',
          call_id: stringValue(call['id']) ?? `call_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
          name,
          arguments: stringValue(fn['arguments']) ?? '{}',
          namespace: CHATGPT_TOOL_NAMESPACE,
        })
      }
      const legacyCall = objectValue(message['function_call'])
      if (legacyCall !== undefined) {
        const name = stringValue(legacyCall['name'])
        if (name !== undefined) {
          items.push({
            type: 'function_call',
            call_id: `call_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
            name,
            arguments: stringValue(legacyCall['arguments']) ?? '{}',
            namespace: CHATGPT_TOOL_NAMESPACE,
          })
        }
      }
      continue
    }
    if (role === 'user') {
      const converted = messageContent(content)
      if (converted !== '') items.push({ role: 'user', content: converted })
    }
  }
  if (items.length === 0) throw new Error('messages 中没有可发送给 ChatGPT 的内容')

  const body: Record<string, unknown> = {
    model,
    input: items,
    store: false,
    stream: true,
  }
  if (instructions.length > 0) body['instructions'] = instructions.join('\n\n')
  const tools = convertTools(input['tools'] ?? input['functions'])
  if (tools !== undefined) body['tools'] = tools
  const toolChoice = convertToolChoice(input['tool_choice'])
  if (toolChoice !== undefined) body['tool_choice'] = toolChoice
  if (typeof input['parallel_tool_calls'] === 'boolean') {
    body['parallel_tool_calls'] = input['parallel_tool_calls']
  }
  const effort = stringValue(input['reasoning_effort'])
  if (effort !== undefined) body['reasoning'] = { effort }
  const format = convertResponseFormat(input['response_format'])
  if (format !== undefined) body['text'] = { format }
  return body
}

function chatChunk(options: {
  id: string
  created: number
  model: string
  delta: Record<string, unknown>
  finishReason?: string | null
  usage?: Record<string, number>
}): string {
  return `data: ${JSON.stringify({
    id: options.id,
    object: 'chat.completion.chunk',
    created: options.created,
    model: options.model,
    choices: [{
      index: 0,
      delta: options.delta,
      finish_reason: options.finishReason ?? null,
      logprobs: null,
    }],
    ...options.usage === undefined ? {} : { usage: options.usage },
  })}\n\n`
}

function usageFromResponse(response: Record<string, unknown>): Record<string, number> | undefined {
  const usage = objectValue(response['usage'])
  if (usage === undefined) return undefined
  const input = numberValue(usage['input_tokens'])
  const output = numberValue(usage['output_tokens'])
  const total = numberValue(usage['total_tokens']) ?? (input !== undefined || output !== undefined
    ? (input ?? 0) + (output ?? 0)
    : undefined)
  if (input === undefined && output === undefined && total === undefined) return undefined
  return {
    ...input === undefined ? {} : { prompt_tokens: input },
    ...output === undefined ? {} : { completion_tokens: output },
    ...total === undefined ? {} : { total_tokens: total },
  }
}

function outputText(output: unknown): string {
  if (!Array.isArray(output)) return ''
  const parts: string[] = []
  for (const rawItem of output) {
    const item = objectValue(rawItem)
    if (item?.['type'] !== 'message' || !Array.isArray(item['content'])) continue
    for (const rawPart of item['content']) {
      const part = objectValue(rawPart)
      if (part?.['type'] === 'output_text' && typeof part['text'] === 'string') parts.push(part['text'])
    }
  }
  return parts.join('')
}

/** 把 Responses SSE 事件转换为 Chat Completions chunk。 */
class ChatStreamTranslator {
  private readonly fallbackModel: string
  private id = `chatcmpl-${randomUUID().replaceAll('-', '').slice(0, 24)}`
  private created = Math.floor(Date.now() / 1000)
  private model: string
  private started = false
  private finished = false
  private failed = false
  private textSent = false
  private toolSequence = 0
  private readonly tools = new Map<number, ChatToolState>()
  private readonly toolByItem = new Map<string, ChatToolState>()
  private readonly toolByCallId = new Map<string, ChatToolState>()
  private usage: Record<string, number> | undefined

  constructor(fallbackModel: string) {
    this.fallbackModel = fallbackModel
    this.model = fallbackModel
  }

  /** 处理一个 Responses 事件并返回需要写给客户端的 SSE 文本。 */
  handle(event: Record<string, unknown>): string[] {
    const type = stringValue(event['type']) ?? ''
    if (type === 'response.created') {
      const response = objectValue(event['response'])
      if (response !== undefined) {
        this.id = stringValue(response['id']) ?? this.id
        this.model = stringValue(response['model']) ?? this.model
        this.created = numberValue(response['created_at']) ?? this.created
      }
      return this.start()
    }
    if (type === 'response.output_item.added') {
      const item = objectValue(event['item'])
      if (item === undefined || (item['type'] !== 'function_call' && item['type'] !== 'custom_tool_call')) return []
      const outputIndex = numberValue(event['output_index']) ?? this.toolSequence
      const state = this.toolState(item, outputIndex)
      if (state.added) return []
      state.added = true
      return [
        ...this.start(),
        ...this.toolChunk({
          index: state.index,
          id: state.id,
          name: state.name,
          arguments: '',
        }),
      ]
    }
    if (type === 'response.output_text.delta') {
      const delta = stringValue(event['delta']) ?? ''
      if (delta === '') return []
      this.textSent = true
      return [...this.start(), this.contentChunk(delta)]
    }
    if (type === 'response.refusal.delta') {
      const delta = stringValue(event['delta']) ?? ''
      if (delta === '') return []
      this.textSent = true
      return [...this.start(), this.contentChunk(delta)]
    }
    if (type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') {
      const delta = stringValue(event['delta']) ?? ''
      if (delta === '') return []
      return [...this.start(), this.reasoningChunk(delta)]
    }
    if (type === 'response.function_call_arguments.delta') {
      const delta = stringValue(event['delta']) ?? ''
      const state = this.findTool(event)
      if (state === undefined) return []
      state.argumentsSent += delta
      return delta === '' ? [] : [...this.start(), ...this.toolChunk({
        index: state.index,
        id: state.id,
        name: state.name,
        arguments: delta,
        header: false,
      })]
    }
    if (type === 'response.output_item.done') {
      const item = objectValue(event['item'])
      if (item === undefined || (item['type'] !== 'function_call' && item['type'] !== 'custom_tool_call')) return []
      const state = this.toolState(item, numberValue(event['output_index']) ?? this.toolSequence)
      const finalArguments = stringValue(item['arguments']) ?? stringValue(item['input']) ?? ''
      if (!state.added) {
        state.added = true
        state.argumentsSent = finalArguments
        return [...this.start(), ...this.toolChunk({
          index: state.index,
          id: state.id,
          name: state.name,
          arguments: finalArguments,
        })]
      }
      const remaining = finalArguments.startsWith(state.argumentsSent)
        ? finalArguments.slice(state.argumentsSent.length)
        : state.argumentsSent === '' ? finalArguments : ''
      state.argumentsSent += remaining
      if (remaining === '') return []
      return [...this.start(), ...this.toolChunk({
        index: state.index,
        id: state.id,
        name: state.name,
        arguments: remaining,
        header: false,
      })]
    }
    if (type === 'response.completed') {
      const response = objectValue(event['response'])
      if (response !== undefined) this.usage = usageFromResponse(response)
      if (!this.textSent && response !== undefined) {
        const text = outputText(response['output'])
        if (text !== '') {
          this.textSent = true
          return [...this.start(), this.contentChunk(text), ...this.finish('stop')]
        }
      }
      return this.finish(this.tools.size > 0 ? 'tool_calls' : 'stop')
    }
    if (type === 'response.incomplete') {
      return this.finish('length')
    }
    if (type === 'response.failed' || type === 'error') {
      this.failed = true
      const error = objectValue(event['error']) ?? objectValue(objectValue(event['response'])?.['error'])
      const message = stringValue(error?.['message'])
        ?? stringValue(event['message'])
        ?? 'ChatGPT Responses 上游返回错误'
      return [
        ...this.start(),
        `data: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\n`,
        'data: [DONE]\n\n',
      ]
    }
    return []
  }

  /** 上游流结束时补齐终止 chunk；缺失 response.completed 时标记异常。 */
  end(): string[] {
    if (this.finished) return []
    if (!this.failed) {
      const error = 'ChatGPT Responses 流在 response.completed 前结束'
      return [
        ...this.start(),
        `data: ${JSON.stringify({ error: { message: error, type: 'upstream_error' } })}\n\n`,
        'data: [DONE]\n\n',
      ]
    }
    return []
  }

  private start(): string[] {
    if (this.started) return []
    this.started = true
    return [chatChunk({
      id: this.id,
      created: this.created,
      model: this.model || this.fallbackModel,
      delta: { role: 'assistant', content: '' },
    })]
  }

  private contentChunk(content: string): string {
    return chatChunk({
      id: this.id,
      created: this.created,
      model: this.model || this.fallbackModel,
      delta: { content },
    })
  }

  private reasoningChunk(reasoning: string): string {
    return chatChunk({
      id: this.id,
      created: this.created,
      model: this.model || this.fallbackModel,
      delta: { reasoning_content: reasoning },
    })
  }

  private toolChunk(options: {
    index: number
    id: string
    name: string
    arguments: string
    header?: boolean
  }): string[] {
    const header = options.header !== false
    return [chatChunk({
      id: this.id,
      created: this.created,
      model: this.model || this.fallbackModel,
      delta: {
        tool_calls: [{
          index: options.index,
          ...header ? { id: options.id, type: 'function' } : {},
          function: {
            ...header ? { name: options.name } : {},
            arguments: options.arguments,
          },
        }],
      },
    })]
  }

  private finish(reason: string): string[] {
    if (this.finished) return []
    this.finished = true
    return [
      chatChunk({
        id: this.id,
        created: this.created,
        model: this.model || this.fallbackModel,
        delta: {},
        finishReason: reason,
        ...this.usage === undefined ? {} : { usage: this.usage },
      }),
      'data: [DONE]\n\n',
    ]
  }

  private toolState(item: Record<string, unknown>, outputIndex: number): ChatToolState {
    const itemId = stringValue(item['id'])
    const callId = stringValue(item['call_id']) ?? itemId ?? `call_${randomUUID().replaceAll('-', '').slice(0, 20)}`
    const existing = (itemId === undefined ? undefined : this.toolByItem.get(itemId))
      ?? this.toolByCallId.get(callId)
    if (existing !== undefined) return existing
    const state: ChatToolState = {
      index: this.toolSequence++,
      id: callId,
      name: stringValue(item['name']) ?? 'tool',
      argumentsSent: '',
      added: false,
    }
    if (itemId !== undefined) this.toolByItem.set(itemId, state)
    this.toolByCallId.set(callId, state)
    this.tools.set(outputIndex, state)
    return state
  }

  private findTool(event: Record<string, unknown>): ChatToolState | undefined {
    const outputIndex = numberValue(event['output_index'])
    if (outputIndex !== undefined) {
      const byIndex = this.tools.get(outputIndex)
      if (byIndex !== undefined) return byIndex
    }
    const itemId = stringValue(event['item_id'])
    if (itemId !== undefined) return this.toolByItem.get(itemId)
    return undefined
  }
}

interface ParsedSseEvent {
  event?: string
  data: string
}

function parseSseBlock(block: string): ParsedSseEvent | undefined {
  let event: string | undefined
  const data: string[] = []
  for (const rawLine of block.split(/\r?\n/)) {
    if (rawLine.startsWith('event:')) event = rawLine.slice(6).trim()
    else if (rawLine.startsWith('data:')) data.push(rawLine.slice(5).trimStart())
  }
  return data.length === 0 ? undefined : { ...event === undefined ? {} : { event }, data: data.join('\n') }
}

/**
 * 将 Responses SSE 字节流包装成 Chat Completions SSE Response。
 *
 * @param upstream 已确认 HTTP 成功的 Responses 响应。
 * @param fallbackModel 入站请求中的模型名，用于缺少 response.created 时兜底。
 */
export function responsesToChatResponse(upstream: Response, fallbackModel: string): Response {
  if (upstream.body === null) throw new Error('ChatGPT Responses 返回了空流')
  const encoder = new TextEncoder()
  const stream = new TransformStream<Uint8Array, Uint8Array>()
  const writer = stream.writable.getWriter()
  const translator = new ChatStreamTranslator(fallbackModel)

  void (async (): Promise<void> => {
    const reader = upstream.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const write = async (text: string): Promise<void> => {
      if (text !== '') await writer.write(encoder.encode(text))
    }
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n')
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''
        for (const block of blocks) {
          const parsed = parseSseBlock(block)
          if (parsed === undefined || parsed.data === '[DONE]') continue
          let event: Record<string, unknown>
          try {
            const value = JSON.parse(parsed.data) as unknown
            const record = objectValue(value)
            if (record === undefined) continue
            event = record
          } catch {
            continue
          }
          for (const chunk of translator.handle(event)) await write(chunk)
        }
      }
      buffer += decoder.decode()
      if (buffer.trim() !== '') {
        const parsed = parseSseBlock(buffer)
        if (parsed !== undefined && parsed.data !== '[DONE]') {
          try {
            const event = objectValue(JSON.parse(parsed.data) as unknown)
            if (event !== undefined) {
              for (const chunk of translator.handle(event)) await write(chunk)
            }
          } catch {
            // 末尾不完整事件忽略，由 end() 统一报错
          }
        }
      }
      for (const chunk of translator.end()) await write(chunk)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        await write(`data: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\n`)
        await write('data: [DONE]\n\n')
      } catch {
        // 下游已断开时无需继续写
      }
    } finally {
      reader.releaseLock()
      await writer.close().catch(() => undefined)
    }
  })()

  return new Response(stream.readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  })
}
