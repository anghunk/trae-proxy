/**
 * Anthropic 上游：把 OpenAI /v1/chat/completions 请求转成 Anthropic
 * /v1/messages，再把响应/流式事件转回 OpenAI SSE。
 *
 * 覆盖：
 * - system 独立字段
 * - user/assistant/tool 消息与 tool_calls 互转
 * - stop_reason → finish_reason
 * - usage 映射
 * - 流式 content_block_delta / message_delta / message_stop → OpenAI chunk
 */

import type { GatewayChatFailure, GatewayChatResult, GatewayModel, UpstreamProvider } from '../providers.ts'
import { readableUpstreamError } from '../providers.ts'
import type { ProviderRecord } from '../store.ts'

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: unknown
}

interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: unknown
  is_error?: boolean
}

function normalizeContent(content: unknown): unknown {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content
  return content.map(item => {
    if (typeof item !== 'object' || item === null) return item
    const record = item as Record<string, unknown>
    if (record['type'] === 'text' && typeof record['text'] === 'string') {
      return { type: 'text', text: record['text'] }
    }
    if (record['type'] === 'image_url' && typeof record['image_url'] === 'object' && record['image_url'] !== null) {
      const url = (record['image_url'] as Record<string, unknown>)['url']
      if (typeof url === 'string') {
        const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,(.*)$/is.exec(url)
        if (match !== null) {
          const mime = match[1]?.toLowerCase() === 'jpg' ? 'jpeg' : match[1]?.toLowerCase() ?? 'png'
          return { type: 'image', source: { type: 'base64', media_type: `image/${mime}`, data: match[2] ?? '' } }
        }
        if (url.startsWith('http://') || url.startsWith('https://')) {
          return { type: 'image', source: { type: 'url', url } }
        }
      }
    }
    return item
  })
}

function messagesFromOpenAI(input: Record<string, unknown>): AnthropicMessage[] {
  const rawMessages = Array.isArray(input['messages']) ? input['messages'] : []
  const result: AnthropicMessage[] = []
  for (const raw of rawMessages) {
    if (typeof raw !== 'object' || raw === null) continue
    const message = raw as Record<string, unknown>
    const role = message['role']
    if (role === 'system' || role === 'developer') continue
    if (role === 'user') {
      result.push({ role: 'user', content: normalizeContent(message['content']) })
      continue
    }
    if (role === 'tool') {
      const toolCallId = typeof message['tool_call_id'] === 'string' ? message['tool_call_id'] : ''
      const block: AnthropicToolResultBlock = {
        type: 'tool_result',
        tool_use_id: toolCallId,
        content: normalizeContent(message['content']),
        ...(message['is_error'] === true ? { is_error: true } : {}),
      }
      // 前一条 assistant tool_use 消息已入队，这里把 tool_result 挂到同一 user 消息。
      const last = result[result.length - 1]
      if (last !== undefined && last.role === 'user' && Array.isArray(last.content)) {
        last.content = [...last.content, block]
      } else {
        result.push({ role: 'user', content: [block] })
      }
      continue
    }
    if (role === 'assistant') {
      const content: unknown[] = []
      const text = typeof message['content'] === 'string' ? message['content'] : ''
      if (text !== '') content.push({ type: 'text', text })
      if (Array.isArray(message['content'])) {
        for (const item of message['content']) {
          if (typeof item === 'object' && item !== null && (item as Record<string, unknown>)['type'] === 'text') {
            content.push(item)
          }
        }
      }
      const toolCalls = Array.isArray(message['tool_calls']) ? message['tool_calls'] : []
      for (const call of toolCalls) {
        if (typeof call !== 'object' || call === null) continue
        const fn = (call as Record<string, unknown>)['function']
        if (typeof fn !== 'object' || fn === null) continue
        const fnRecord = fn as Record<string, unknown>
        const name = typeof fnRecord['name'] === 'string' ? fnRecord['name'] : ''
        let input: unknown = {}
        if (typeof fnRecord['arguments'] === 'string') {
          try { input = JSON.parse(fnRecord['arguments']) } catch { input = fnRecord['arguments'] }
        }
        const block: AnthropicToolUseBlock = {
          type: 'tool_use',
          id: typeof (call as Record<string, unknown>)['id'] === 'string' ? (call as Record<string, unknown>)['id'] as string : `toolu_${content.length}`,
          name,
          input,
        }
        content.push(block)
      }
      result.push({ role: 'assistant', content })
      continue
    }
  }
  return result
}

function extractSystem(input: Record<string, unknown>): string {
  const messages = Array.isArray(input['messages']) ? input['messages'] : []
  for (const raw of messages) {
    if (typeof raw !== 'object' || raw === null) continue
    const message = raw as Record<string, unknown>
    if ((message['role'] === 'system' || message['role'] === 'developer') && typeof message['content'] === 'string') {
      return message['content']
    }
  }
  return ''
}

function buildAnthropicBody(input: Record<string, unknown>): Record<string, unknown> {
  const model = typeof input['model'] === 'string' ? input['model'] : ''
  const system = extractSystem(input)
  const body: Record<string, unknown> = {
    model,
    max_tokens: typeof input['max_tokens'] === 'number' ? input['max_tokens'] : 4096,
    messages: messagesFromOpenAI(input),
    stream: input['stream'] === true,
  }
  if (system !== '') body['system'] = system
  if (typeof input['temperature'] === 'number') body['temperature'] = input['temperature']
  if (typeof input['top_p'] === 'number') body['top_p'] = input['top_p']
  if (Array.isArray(input['tools'])) {
    body['tools'] = input['tools'].map(tool => {
      if (typeof tool !== 'object' || tool === null) return tool
      const record = tool as Record<string, unknown>
      const fn = record['function']
      if (typeof fn !== 'object' || fn === null) return tool
      const fnRecord = fn as Record<string, unknown>
      return {
        name: typeof fnRecord['name'] === 'string' ? fnRecord['name'] : '',
        description: typeof fnRecord['description'] === 'string' ? fnRecord['description'] : '',
        input_schema: fnRecord['parameters'] ?? { type: 'object', properties: {} },
      }
    })
  }
  return body
}

function classifyStatus(status: number): GatewayChatFailure['kind'] {
  if (status === 401 || status === 403) return 'authentication'
  if (status === 402) return 'hard_credit'
  if (status === 404) return 'not_found'
  if (status === 429) return 'soft_rate'
  if (status >= 500) return 'server'
  return 'client'
}

function anthropicModelsToGateway(raw: unknown): GatewayModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const id = typeof record['id'] === 'string' ? record['id'] : ''
  if (id === '') return undefined
  const window = typeof record['context_window'] === 'number' ? record['context_window'] : undefined
  const max = typeof record['max_output_tokens'] === 'number' ? record['max_output_tokens'] : undefined
  return {
    id,
    name: typeof record['display_name'] === 'string' ? record['display_name'] : id,
    ...(window === undefined ? {} : { contextWindow: window }),
    ...(max === undefined ? {} : { maxTokens: max }),
  }
}

function streamChunk(id: string, created: number, model: string, delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

function bridgeAnthropicStream(response: Response, model: string): Response {
  const source = response.body
  if (source === null) return new Response(null, { status: 502 })
  const id = `chatcmpl-${Math.random().toString(36).slice(2, 14)}`
  const created = Math.floor(Date.now() / 1000)
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let sawToolUse = false

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (data === '[DONE]') continue
            let event: Record<string, unknown>
            try { event = JSON.parse(data) as Record<string, unknown> } catch { continue }
            const type = event['type']
            if (type === 'content_block_delta') {
              const delta = event['delta'] as Record<string, unknown> | undefined
              if (delta === undefined) continue
              const deltaType = delta['type']
              if (deltaType === 'text_delta' && typeof delta['text'] === 'string') {
                controller.enqueue(encoder.encode(streamChunk(id, created, model, { content: delta['text'] }, null)))
              } else if (deltaType === 'input_json_delta' && typeof delta['partial_json'] === 'string') {
                if (!sawToolUse) {
                  sawToolUse = true
                  controller.enqueue(encoder.encode(streamChunk(id, created, model, {
                    tool_calls: [{ index: 0, id: `call_${Math.random().toString(36).slice(2, 10)}`, type: 'function', function: { name: '', arguments: '' } }],
                  }, null)))
                }
                controller.enqueue(encoder.encode(streamChunk(id, created, model, {
                  tool_calls: [{ index: 0, function: { arguments: delta['partial_json'] } }],
                }, null)))
              }
            } else if (type === 'content_block_start') {
              const block = event['content_block'] as Record<string, unknown> | undefined
              if (block !== undefined && block['type'] === 'tool_use' && typeof block['name'] === 'string') {
                sawToolUse = true
                controller.enqueue(encoder.encode(streamChunk(id, created, model, {
                  tool_calls: [{ index: 0, id: typeof block['id'] === 'string' ? block['id'] : `call_${Math.random().toString(36).slice(2, 10)}`, type: 'function', function: { name: block['name'], arguments: '' } }],
                }, null)))
              }
            } else if (type === 'message_delta') {
              const stop = (event['delta'] as Record<string, unknown> | undefined)?.['stop_reason']
              const reason = stop === 'tool_use' ? 'tool_calls' : stop === 'max_tokens' ? 'length' : stop === 'end_turn' ? 'stop' : undefined
              if (reason !== undefined) {
                controller.enqueue(encoder.encode(streamChunk(id, created, model, {}, reason)))
              }
            }
          }
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      } catch (error) {
        controller.error(error)
      } finally {
        reader.releaseLock()
      }
    },
    cancel(reason) { return source.cancel(reason) },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

export class AnthropicProvider implements UpstreamProvider {
  readonly id: string
  private readonly record: ProviderRecord
  private readonly logger?: (message: string, detail?: unknown) => void

  constructor(options: { record: ProviderRecord; logger?: (message: string, detail?: unknown) => void }) {
    this.id = options.record.id
    this.record = options.record
    this.logger = options.logger
  }

  private baseUrl(): string {
    return (this.record.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': this.record.apiKey ?? '',
    }
    try {
      const extra = JSON.parse(this.record.extraHeaders) as Record<string, unknown>
      for (const [key, value] of Object.entries(extra)) {
        if (typeof value === 'string' && value !== '') headers[key] = value
      }
    } catch {
      // ignore
    }
    return headers
  }

  async listModels(): Promise<GatewayModel[]> {
    const response = await fetch(`${this.baseUrl()}/v1/models`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`anthropic models HTTP ${response.status}`)
    const document = (await response.json()) as { data?: unknown }
    const models = (Array.isArray(document.data) ? document.data : [])
      .map(anthropicModelsToGateway)
      .filter((model): model is GatewayModel => model !== undefined)
    if (models.length === 0) throw new Error('anthropic models response contained no models')
    return models
  }

  async chat(bodyJson: string, signal?: AbortSignal): Promise<GatewayChatResult | GatewayChatFailure> {
    let input: Record<string, unknown>
    try {
      input = JSON.parse(bodyJson) as Record<string, unknown>
    } catch {
      return { ok: false, status: 400, kind: 'client', message: 'invalid JSON request' }
    }
    const anthropicBody = buildAnthropicBody(input)
    const isStream = input['stream'] === true
    let response: Response
    try {
      response = await fetch(`${this.baseUrl()}/v1/messages`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(anthropicBody),
        signal: signal ?? AbortSignal.timeout(this.record.timeoutMs ?? 120_000),
      })
    } catch (error: unknown) {
      return {
        ok: false,
        status: 0,
        kind: 'server',
        message: `anthropic transport error: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (!response.ok) {
      const text = await response.text()
      this.logger?.('anthropic chat rejected', { providerId: this.id, status: response.status, body: text.slice(0, 2048) })
      return {
        ok: false,
        status: response.status,
        kind: classifyStatus(response.status),
        message: readableUpstreamError(text, `anthropic upstream returned HTTP ${response.status}`),
      }
    }
    if (isStream) {
      return { ok: true, response: bridgeAnthropicStream(response, String(anthropicBody['model'] ?? '')) }
    }
    const json = (await response.json()) as Record<string, unknown>
    const converted = anthropicToOpenAiCompletion(json, String(anthropicBody['model'] ?? ''))
    return { ok: true, response: new Response(JSON.stringify(converted), { status: 200, headers: { 'Content-Type': 'application/json' } }) }
  }
}

function anthropicToOpenAiCompletion(json: Record<string, unknown>, model: string): Record<string, unknown> {
  const content = Array.isArray(json['content']) ? json['content'] : []
  const message: Record<string, unknown> = { role: 'assistant', content: '' }
  const toolCalls: Record<string, unknown>[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record['type'] === 'text' && typeof record['text'] === 'string') {
      message['content'] = String(message['content'] ?? '') + record['text']
    } else if (record['type'] === 'tool_use') {
      toolCalls.push({
        id: record['id'],
        type: 'function',
        function: {
          name: record['name'],
          arguments: typeof record['input'] === 'string' ? record['input'] : JSON.stringify(record['input'] ?? {}),
        },
      })
    }
  }
  if (toolCalls.length > 0) message['tool_calls'] = toolCalls
  const usage = json['usage'] as Record<string, unknown> | undefined
  const inputTokens = typeof usage?.['input_tokens'] === 'number' ? usage['input_tokens'] : undefined
  const outputTokens = typeof usage?.['output_tokens'] === 'number' ? usage['output_tokens'] : undefined
  const stopReason = json['stop_reason'] === 'tool_use' ? 'tool_calls' : json['stop_reason'] === 'max_tokens' ? 'length' : 'stop'
  return {
    id: `chatcmpl-${Math.random().toString(36).slice(2, 14)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: stopReason }],
    ...(inputTokens === undefined && outputTokens === undefined
      ? {}
      : {
          usage: {
            ...(inputTokens === undefined ? {} : { prompt_tokens: inputTokens }),
            ...(outputTokens === undefined ? {} : { completion_tokens: outputTokens }),
            ...(inputTokens !== undefined && outputTokens !== undefined ? { total_tokens: inputTokens + outputTokens } : {}),
          },
        }),
  }
}
