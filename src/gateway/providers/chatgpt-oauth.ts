/**
 * ChatGPT 订阅渠道。
 *
 * 该 provider 通过 OpenAI Sign in with ChatGPT 获取用户授权，并使用
 * ChatGPT Plus / Pro / Business 套餐额度调用公开的 Responses API。
 * 对网关其他部分仍暴露统一的 Chat Completions 结果。
 *
 * @module trae-proxy/gateway/providers/chatgpt-oauth
 */

import { join } from 'node:path'
import { CONFIG_DIR, type ProviderRecord } from '../store.ts'
import type {
  ChatRequestContext,
  GatewayChatFailure,
  GatewayChatResult,
  GatewayModel,
  UpstreamProvider,
} from '../providers.ts'
import { readableUpstreamError } from '../providers.ts'
import {
  ChatgptCredentialStore,
  describeChatgptCredential,
  pollChatgptLogin,
  signOutChatgpt,
  startChatgptLogin,
  type ChatgptCredential,
  type ChatgptLoginPoll,
  type ChatgptLoginStart,
  type ChatgptSessionDescription,
} from './chatgpt-auth.ts'
import {
  chatRequestToResponses,
  responsesToChatResponse,
} from './chatgpt-responses.ts'

const CHATGPT_API = 'https://api.openai.com/v1'
const MODEL_CACHE_TTL_MS = 5 * 60_000
const DEFAULT_TIMEOUT_MS = 10 * 60_000

/** 管理台可调用的 ChatGPT 登录态接口。 */
export interface ChatgptSessionApi {
  sessionStatus(): Promise<ChatgptSessionDescription>
  startLogin(): Promise<ChatgptLoginStart>
  pollLogin(): ChatgptLoginPoll
  signOut(): Promise<{ remoteRevoked: boolean }>
}

export interface ChatgptOAuthProviderOptions {
  record: ProviderRecord
  logger?: (message: string, detail?: unknown) => void
  credentialPath?: string
}

function parseSettings(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function defaultCredentialPath(id: string): string {
  return join(CONFIG_DIR, `chatgpt-oauth-${id}.json`)
}

function classifyStatus(status: number): GatewayChatFailure['kind'] {
  if (status === 401 || status === 403) return 'authentication'
  if (status === 402) return 'hard_credit'
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  return 'client'
}

function structuredError(text: string, fallback: string): string {
  const readable = readableUpstreamError(text, fallback)
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const error = typeof parsed['error'] === 'object' && parsed['error'] !== null
      ? parsed['error'] as Record<string, unknown>
      : undefined
    const code = typeof error?.['code'] === 'string' ? error['code'] : undefined
    if (typeof parsed['detail'] === 'string' && parsed['detail'] !== '') return parsed['detail']
    return code === undefined || readable.includes(code) ? readable : `${readable} [${code}]`
  } catch {
    return readable
  }
}

function modelName(record: Record<string, unknown>, fallback: string): string {
  for (const key of ['display_name', 'displayName', 'name']) {
    if (typeof record[key] === 'string' && record[key] !== '') return record[key]
  }
  return fallback
}

function modelNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'number' && Number.isFinite(record[key]) && record[key] > 0) {
      return record[key]
    }
  }
  return undefined
}

export class ChatgptOAuthProvider implements UpstreamProvider, ChatgptSessionApi {
  readonly id: string
  private readonly record: ProviderRecord
  private readonly logger?: (message: string, detail?: unknown) => void
  private readonly credentials: ChatgptCredentialStore
  private modelCache: { at: number; models: GatewayModel[] } | undefined

  constructor(options: ChatgptOAuthProviderOptions) {
    this.id = options.record.id
    this.record = options.record
    this.logger = options.logger
    const settings = parseSettings(options.record.settings)
    const configured = typeof settings['credentialPath'] === 'string' && settings['credentialPath'] !== ''
      ? settings['credentialPath']
      : undefined
    this.credentials = new ChatgptCredentialStore(
      options.credentialPath ?? configured ?? defaultCredentialPath(this.id),
      options.logger,
    )
  }

  async listModels(): Promise<GatewayModel[]> {
    const cached = this.modelCache
    if (cached !== undefined && Date.now() - cached.at < MODEL_CACHE_TTL_MS && cached.models.length > 0) {
      return cached.models
    }
    return this.refreshModels()
  }

  async refreshModels(): Promise<GatewayModel[]> {
    let credential = await this.credentials.ensure()
    let response = await this.fetchModels(credential)
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined)
      credential = await this.credentials.forceRefresh(credential)
      response = await this.fetchModels(credential)
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(structuredError(text, `ChatGPT 模型目录返回 HTTP ${response.status}`))
    }
    const document = await response.json() as Record<string, unknown>
    const candidates = Array.isArray(document['models'])
      ? document['models']
      : Array.isArray(document['data']) ? document['data'] : []
    const models: GatewayModel[] = []
    for (const raw of candidates) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
      const entry = raw as Record<string, unknown>
      const visibility = entry['visibility']
      if (typeof visibility === 'string' && visibility !== 'list' && visibility !== 'default') continue
      const id = typeof entry['slug'] === 'string'
        ? entry['slug']
        : typeof entry['id'] === 'string' ? entry['id'] : ''
      if (id === '') continue
      const contextWindow = modelNumber(entry, [
        'context_window',
        'contextWindow',
        'max_context_window',
        'context_length',
      ])
      const maxTokens = modelNumber(entry, ['max_output_tokens', 'maxTokens'])
      models.push({
        id,
        name: modelName(entry, id),
        ...contextWindow === undefined ? {} : { contextWindow },
        ...maxTokens === undefined ? {} : { maxTokens },
      })
    }
    if (models.length === 0) throw new Error('ChatGPT 模型目录为空，请确认账号已授权使用套餐额度')
    this.modelCache = { at: Date.now(), models }
    return models
  }

  async chat(
    bodyJson: string,
    signal?: AbortSignal,
    _context?: ChatRequestContext,
  ): Promise<GatewayChatResult | GatewayChatFailure> {
    let input: Record<string, unknown>
    try {
      const parsed = JSON.parse(bodyJson) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, status: 400, kind: 'client', message: 'invalid JSON request' }
      }
      input = parsed as Record<string, unknown>
    } catch {
      return { ok: false, status: 400, kind: 'client', message: 'invalid JSON request' }
    }
    const model = typeof input['model'] === 'string' ? input['model'] : ''
    let responsesBody: Record<string, unknown>
    try {
      responsesBody = chatRequestToResponses(input)
    } catch (error: unknown) {
      return {
        ok: false,
        status: 400,
        kind: 'client',
        message: error instanceof Error ? error.message : String(error),
      }
    }

    let credential: ChatgptCredential
    try {
      credential = await this.credentials.ensure(signal)
    } catch (error: unknown) {
      return {
        ok: false,
        status: 401,
        kind: 'authentication',
        message: error instanceof Error ? error.message : String(error),
      }
    }

    let response = await this.send(credential, responsesBody, signal)
    if (response instanceof Error) {
      return { ok: false, status: 0, kind: 'server', message: response.message }
    }
    if (response.status === 401) {
      try {
        credential = await this.credentials.forceRefresh(credential, signal)
        await response.body?.cancel().catch(() => undefined)
        response = await this.send(credential, responsesBody, signal)
      } catch (error: unknown) {
        return {
          ok: false,
          status: 401,
          kind: 'authentication',
          message: error instanceof Error ? error.message : String(error),
        }
      }
      if (response instanceof Error) {
        return { ok: false, status: 0, kind: 'server', message: response.message }
      }
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      this.logger?.('ChatGPT Responses 拒绝了请求', {
        providerId: this.id,
        status: response.status,
        body: text.slice(0, 2048),
      })
      return {
        ok: false,
        status: response.status,
        kind: classifyStatus(response.status),
        message: structuredError(text, `ChatGPT Responses 返回 HTTP ${response.status}`),
      }
    }
    try {
      return {
        ok: true,
        response: responsesToChatResponse(response, model),
      }
    } catch (error: unknown) {
      await response.body?.cancel().catch(() => undefined)
      return {
        ok: false,
        status: 502,
        kind: 'server',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** 管理台展示的运行状态。 */
  status(): Promise<unknown> {
    const session = describeChatgptCredential(this.credentials.load())
    return Promise.resolve({
      mode: 'chatgpt-plan',
      endpoint: `${CHATGPT_API}/responses`,
      models: this.modelCache?.models.length ?? 0,
      ...session,
    })
  }

  sessionStatus(): Promise<ChatgptSessionDescription> {
    return Promise.resolve(describeChatgptCredential(this.credentials.load()))
  }

  startLogin(): Promise<ChatgptLoginStart> {
    return startChatgptLogin(this.id, this.credentials)
  }

  pollLogin(): ChatgptLoginPoll {
    const result = pollChatgptLogin(this.id)
    if (result.status === 'done') this.modelCache = undefined
    return result
  }

  signOut(): Promise<{ remoteRevoked: boolean }> {
    this.modelCache = undefined
    return signOutChatgpt(this.credentials)
  }

  close(): void {}

  private fetchModels(credential: ChatgptCredential): Promise<Response> {
    return fetch(`${CHATGPT_API}/models`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${credential.accessToken ?? ''}`,
      },
      signal: AbortSignal.timeout(30_000),
    })
  }

  private async send(
    credential: ChatgptCredential,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response | Error> {
    const timeout = this.record.timeoutMs !== undefined && this.record.timeoutMs > 0
      ? this.record.timeoutMs
      : DEFAULT_TIMEOUT_MS
    const timeoutSignal = AbortSignal.timeout(timeout)
    const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
    try {
      return await fetch(`${CHATGPT_API}/responses`, {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${credential.accessToken ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: combined,
      })
    } catch (error: unknown) {
      return new Error(`ChatGPT Responses 网络请求失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
