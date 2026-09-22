/**
 * Gemini 上游：把 OpenAI /v1/chat/completions 请求转成 Gemini
 * generateContent / streamGenerateContent，再转回 OpenAI 格式。
 */

import type { GatewayChatFailure, GatewayChatResult, GatewayModel, UpstreamProvider } from '../providers.ts'
import { readableUpstreamError } from '../providers.ts'
import type { ProviderRecord } from '../store.ts'

function normalizeGeminiContent(content: unknown): unknown {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content
  return content.map(item => {
    if (typeof item !== 'object' || item === null) return item
    const record = item as Record<string, unknown>
    if (record['type'] === 'text' && typeof record['text'] === 'string') return record['text']
    if (record['type'] === 'image_url' && typeof record['image_url'] === 'object' && record['image_url'] !== null) {
      const url = (record['image_url'] as Record<string, unknown>)['url']
      if (typeof url === 'string' && /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(url)) {
        const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,(.*)$/is.exec(url)
        if (match !== null) {
          const mime = match[1]?.toLowerCase() === 'jpg' ? 'jpeg' : match[1]?.toLowerCase() ?? 'png'
          return {
            inlineData: {
              mimeType: `image/${mime}`,
              data: match[2] ?? '',
            },
          }
        }
      }
      if (typeof url === 'string' && url !== '') {
        return { fileData: { fileUri: url, mimeType: 'image/png' } }
      }
    }
    return item
  })
}

function partsFromOpenAI(input: Record<string, unknown>): unknown[] {
  const messages = Array.isArray(input['messages']) ? input['messages'] : []
  const parts: unknown[] = []
  for (const raw of messages) {
    if (typeof raw !== 'object' || raw === null) continue
    const message = raw as Record<string, unknown>
    const role = message['role']
    if (role === 'system' || role === 'developer') {
      const text = typeof message['content'] === 'string' ? message['content'] : ''
      if (text !== '') parts.push({ text })
      continue
    }
    const content = normalizeGeminiContent(message['content'])
    if (typeof content === 'string' && content !== '') {
      parts.push({ text: content })
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item === 'string' && item !== '') parts.push({ text: item })
        else parts.push(item)
      }
    }
  }
  return parts
}

function buildGeminiBody(input: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: partsFromOpenAI(input) }],
  }
  if (typeof input['temperature'] === 'number') body['generationConfig'] = { ...(body['generationConfig'] as object), temperature: input['temperature'] }
  if (typeof input['max_tokens'] === 'number') {
    body['generationConfig'] = { ...(body['generationConfig'] as object), maxOutputTokens: input['max_tokens'] }
  }
  if (typeof input['top_p'] === 'number') {
    body['generationConfig'] = { ...(body['generationConfig'] as object), topP: input['top_p'] }
  }
  if (Array.isArray(input['tools'])) {
    const tools = input['tools'].map(tool => {
      if (typeof tool !== 'object' || tool === null) return tool
      const record = tool as Record<string, unknown>
      const fn = record['function']
      if (typeof fn !== 'object' || fn === null) return tool
      const fnRecord = fn as Record<string, unknown>
      return {
        functionDeclarations: [{
          name: fnRecord['name'],
          description: fnRecord['description'],
          parameters: fnRecord['parameters'] ?? { type: 'object', properties: {} },
        }],
      }
    })
    body['tools'] = tools
  }
  return body
}

function classifyStatus(status: number): GatewayChatFailure['kind'] {
  if (status === 401 || status === 403) return 'authentication'
  if (status === 404) return 'not_found'
  if (status === 429) return 'soft_rate'
  if (status >= 500) return 'server'
  return 'client'
}

function chunk(id: string, created: number, model: string, delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

function bridgeGeminiStream(response: Response, model: string): Response {
  const source = response.body
  if (source === null) return new Response(null, { status: 502 })
  const id = `chatcmpl-${Math.random().toString(36).slice(2, 14)}`
  const created = Math.floor(Date.now() / 1000)
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''

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
            let payload: Record<string, unknown>
            try { payload = JSON.parse(data) as Record<string, unknown> } catch { continue }
            const candidates = Array.isArray(payload['candidates']) ? payload['candidates'] : []
            const candidate = candidates[0] as Record<string, unknown> | undefined
            if (candidate === undefined) continue
            const content = candidate['content'] as Record<string, unknown> | undefined
            if (content !== undefined) {
              const parts = Array.isArray(content['parts']) ? content['parts'] : []
              for (const part of parts) {
                if (typeof part !== 'object' || part === null) continue
                const record = part as Record<string, unknown>
                if (typeof record['text'] === 'string' && record['text'] !== '') {
                  controller.enqueue(encoder.encode(chunk(id, created, model, { content: record['text'] }, null)))
                }
              }
            }
            if (candidate['finishReason'] !== undefined && candidate['finishReason'] !== null) {
              const reason = candidate['finishReason'] === 'STOP' ? 'stop' : candidate['finishReason'] === 'MAX_TOKENS' ? 'length' : 'stop'
              controller.enqueue(encoder.encode(chunk(id, created, model, {}, reason)))
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

export class GeminiProvider implements UpstreamProvider {
  readonly id: string
  private readonly record: ProviderRecord
  private readonly logger?: (message: string, detail?: unknown) => void

  constructor(options: { record: ProviderRecord; logger?: (message: string, detail?: unknown) => void }) {
    this.id = options.record.id
    this.record = options.record
    this.logger = options.logger
  }

  private baseUrl(): string {
    return (this.record.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/$/, '')
  }

  private apiKey(): string {
    return this.record.apiKey ?? ''
  }

  async listModels(): Promise<GatewayModel[]> {
    const response = await fetch(`${this.baseUrl()}/v1beta/models?key=${encodeURIComponent(this.apiKey())}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`gemini models HTTP ${response.status}`)
    const document = (await response.json()) as { models?: unknown }
    const models = (Array.isArray(document.models) ? document.models : [])
      .map(raw => {
        if (typeof raw !== 'object' || raw === null) return undefined
        const record = raw as Record<string, unknown>
        const name = typeof record['name'] === 'string' ? record['name'] : ''
        const id = name.startsWith('models/') ? name.slice('models/'.length) : name
        if (id === '') return undefined
        return {
          id,
          name: typeof record['displayName'] === 'string' ? record['displayName'] : id,
          ...(typeof record['contextWindow'] === 'number' ? { contextWindow: record['contextWindow'] } : {}),
        }
      })
      .filter((model): model is GatewayModel => model !== undefined)
    if (models.length === 0) throw new Error('gemini models response contained no models')
    return models
  }

  async chat(bodyJson: string, signal?: AbortSignal): Promise<GatewayChatResult | GatewayChatFailure> {
    let input: Record<string, unknown>
    try {
      input = JSON.parse(bodyJson) as Record<string, unknown>
    } catch {
      return { ok: false, status: 400, kind: 'client', message: 'invalid JSON request' }
    }
    const model = typeof input['model'] === 'string' ? input['model'] : ''
    const isStream = input['stream'] === true
    const body = buildGeminiBody(input)
    const path = isStream ? '/v1beta/models/' : '/v1beta/models/'
    const url = `${this.baseUrl()}${path}${encodeURIComponent(model)}:${isStream ? 'streamGenerateContent' : 'generateContent'}?key=${encodeURIComponent(this.apiKey())}${isStream ? '&alt=sse' : ''}`
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(this.record.timeoutMs ?? 120_000),
      })
    } catch (error: unknown) {
      return {
        ok: false,
        status: 0,
        kind: 'server',
        message: `gemini transport error: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (!response.ok) {
      const text = await response.text()
      this.logger?.('gemini chat rejected', { providerId: this.id, status: response.status, body: text.slice(0, 2048) })
      return {
        ok: false,
        status: response.status,
        kind: classifyStatus(response.status),
        message: readableUpstreamError(text, `gemini upstream returned HTTP ${response.status}`),
      }
    }
    if (isStream) return { ok: true, response: bridgeGeminiStream(response, model) }
    const json = (await response.json()) as Record<string, unknown>
    return { ok: true, response: new Response(JSON.stringify(geminiToOpenAiCompletion(json, model)), { status: 200, headers: { 'Content-Type': 'application/json' } }) }
  }
}

function geminiToOpenAiCompletion(json: Record<string, unknown>, model: string): Record<string, unknown> {
  const candidates = Array.isArray(json['candidates']) ? json['candidates'] : []
  const candidate = candidates[0] as Record<string, unknown> | undefined
  let content = ''
  if (candidate !== undefined) {
    const parts = (candidate['content'] as Record<string, unknown> | undefined)?.['parts']
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (typeof part === 'object' && part !== null && typeof (part as Record<string, unknown>)['text'] === 'string') {
          content += (part as Record<string, unknown>)['text']
        }
      }
    }
  }
  const usage = json['usageMetadata'] as Record<string, unknown> | undefined
  const promptTokens = typeof usage?.['promptTokenCount'] === 'number' ? usage['promptTokenCount'] : undefined
  const candidatesTokens = typeof usage?.['candidatesTokenCount'] === 'number' ? usage['candidatesTokenCount'] : undefined
  return {
    id: `chatcmpl-${Math.random().toString(36).slice(2, 14)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    ...(promptTokens === undefined && candidatesTokens === undefined
      ? {}
      : {
          usage: {
            ...(promptTokens === undefined ? {} : { prompt_tokens: promptTokens }),
            ...(candidatesTokens === undefined ? {} : { completion_tokens: candidatesTokens }),
            ...(promptTokens !== undefined && candidatesTokens !== undefined ? { total_tokens: promptTokens + candidatesTokens } : {}),
          },
        }),
  }
}
