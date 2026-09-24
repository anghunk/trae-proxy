/**
 * Ollama 上游：OpenAI 兼容转发，并在本地服务未运行时按需拉起 ollama CLI。
 * 默认 baseUrl 为 http://127.0.0.1:11434/v1。
 */

import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { OpenAiCompatibleProvider, type OpenAiProviderOptions } from './openai.ts'
import type { ProviderRecord } from '../store.ts'
import type { GatewayChatFailure, GatewayChatResult, GatewayModel } from '../providers.ts'
import type { ChatRequestContext } from '../providers.ts'

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1'
const SERVER_START_TIMEOUT_MS = 45_000
const SERVER_PROBE_TIMEOUT_MS = 1_000
const SERVER_PROBE_INTERVAL_MS = 250
const SERVER_STOP_WAIT_MS = 2_000

interface LocalOllamaServer {
  origin: string
  host: string
}

/**
 * 管理由网关启动的本地 Ollama 服务。
 *
 * 使用引用计数是为了兼容渠道热重载：旧 provider 实例先释放，新实例随即
 * 重新持有，不会因一次配置保存反复杀掉并重启 Ollama 进程。
 */
class ManagedOllamaServer {
  private readonly origin: string
  private readonly host: string
  private readonly logger?: (message: string, detail?: unknown) => void
  private refs = 0
  private child: ChildProcess | undefined
  private startPromise: Promise<void> | undefined
  private stopPromise: Promise<void> | undefined

  constructor(local: LocalOllamaServer, logger?: (message: string, detail?: unknown) => void) {
    this.origin = local.origin
    this.host = local.host
    this.logger = logger
  }

  /** 为 provider 实例增加一次持有。 */
  addRef(): void {
    this.refs += 1
  }

  /** 释放 provider 持有；最后一个持有方离开后停止由本实例启动的服务。 */
  async release(): Promise<void> {
    this.refs = Math.max(0, this.refs - 1)
    if (this.refs > 0) return
    if (this.stopPromise !== undefined) return this.stopPromise
    servers.delete(this.origin)
    this.stopPromise = this.stop()
      .finally(() => {
        this.stopPromise = undefined
      })
    return this.stopPromise
  }

  /** 确保本地 Ollama 服务可访问；不可达时通过 CLI 启动。 */
  async ensure(): Promise<void> {
    if (await probeServer(this.origin)) return
    if (this.startPromise !== undefined) return this.startPromise
    this.startPromise = this.start()
      .finally(() => {
        this.startPromise = undefined
      })
    return this.startPromise
  }

  /** 启动 `ollama serve` 并等待 HTTP 端点就绪。 */
  private async start(): Promise<void> {
    const binary = findOllamaBinary()
    if (binary === undefined) {
      throw new Error('未找到 ollama CLI，请先安装 Ollama，或设置 OLLAMA_BIN 指向可执行文件')
    }
    this.logger?.('starting local Ollama server', { binary, host: this.host })
    const child = spawn(binary, ['serve'], {
      env: { ...process.env, OLLAMA_HOST: this.host },
      stdio: 'ignore',
      windowsHide: true,
    })
    this.child = child
    let spawnError: Error | undefined
    child.once('error', error => {
      spawnError = error
    })

    const deadline = Date.now() + SERVER_START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await probeServer(this.origin)) {
        this.logger?.('local Ollama server is ready', { origin: this.origin, pid: child.pid })
        return
      }
      if (spawnError !== undefined) {
        this.child = undefined
        throw new Error(`启动 ollama CLI 失败: ${spawnError.message}`)
      }
      if (child.exitCode !== null) {
        if (await probeServer(this.origin)) return
        this.child = undefined
        throw new Error(`ollama serve 已退出（退出码 ${child.exitCode}）`)
      }
      await delay(SERVER_PROBE_INTERVAL_MS)
    }
    child.kill()
    this.child = undefined
    throw new Error(`等待本地 Ollama 服务启动超时（${this.host}）`)
  }

  /** 停止由当前管理器启动的 Ollama 服务；外部已运行的服务不会受影响。 */
  private async stop(): Promise<void> {
    const child = this.child
    this.child = undefined
    if (child === undefined || child.exitCode !== null) return
    child.kill('SIGTERM')
    await new Promise<void>(resolve => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish()
      }, SERVER_STOP_WAIT_MS)
      child.once('exit', finish)
    })
  }
}

const servers = new Map<string, ManagedOllamaServer>()

export class OllamaProvider extends OpenAiCompatibleProvider {
  private readonly server: ManagedOllamaServer | undefined

  constructor(options: OpenAiProviderOptions) {
    const record = normalizeOllamaRecord(options.record)
    super({
      ...options,
      record,
    })
    const local = localServerTarget(record.baseUrl ?? DEFAULT_BASE_URL)
    if (local !== undefined) {
      let server = servers.get(local.origin)
      if (server === undefined) {
        server = new ManagedOllamaServer(local, options.logger)
        servers.set(local.origin, server)
      }
      server.addRef()
      this.server = server
    } else {
      this.server = undefined
    }
  }

  /** 模型目录请求前确保本地 CLI 服务已启动。 */
  override async listModels(): Promise<GatewayModel[]> {
    await this.ensureLocalServer()
    return super.listModels()
  }

  /** 对话请求前确保本地 CLI 服务已启动，并复用 OpenAI 兼容转发。 */
  override async chat(
    bodyJson: string,
    signal?: AbortSignal,
    context?: ChatRequestContext,
  ): Promise<GatewayChatResult | GatewayChatFailure> {
    try {
      await this.ensureLocalServer()
    } catch (error: unknown) {
      return {
        ok: false,
        status: 503,
        kind: 'unconfigured',
        message: error instanceof Error ? error.message : String(error),
      }
    }
    return super.chat(withUsageStreamOption(bodyJson), signal, context)
  }

  /** 释放对托管 Ollama 服务的引用。 */
  close(): Promise<void> {
    return this.server?.release() ?? Promise.resolve()
  }

  /** 本地地址不可达时按需启动 CLI；远程自定义地址保持原样。 */
  private async ensureLocalServer(): Promise<void> {
    await this.server?.ensure()
  }
}

/**
 * 让 Ollama 在流式响应末尾附带 usage。
 *
 * Ollama 的 OpenAI 兼容层默认只在非流式响应中返回 token 用量；流式请求
 * 需要显式设置 `stream_options.include_usage`，否则网关只能记录为 0。
 */
function withUsageStreamOption(bodyJson: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyJson)
  } catch {
    return bodyJson
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return bodyJson
  const body = parsed as Record<string, unknown>
  if (body['stream'] !== true) return bodyJson
  const current = body['stream_options']
  const streamOptions = typeof current === 'object' && current !== null && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {}
  body['stream_options'] = { ...streamOptions, include_usage: true }
  return JSON.stringify(body)
}

export function normalizeOllamaRecord(record: ProviderRecord): ProviderRecord {
  return { ...record, baseUrl: record.baseUrl ?? DEFAULT_BASE_URL }
}

/** 把本地 HTTP 地址转换为 Ollama CLI 可识别的服务监听地址。 */
function localServerTarget(baseUrl: string): LocalOllamaServer | undefined {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:') return undefined
  const hostname = url.hostname.toLowerCase()
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1' && hostname !== '[::1]') {
    return undefined
  }
  const port = url.port || '11434'
  const host = hostname === 'localhost' ? `127.0.0.1:${port}` : `${url.hostname}:${port}`
  return { origin: url.origin, host }
}

/** 检测服务是否已有 HTTP 响应；状态码非 2xx 也说明服务已经启动。 */
async function probeServer(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/version`, {
      signal: AbortSignal.timeout(SERVER_PROBE_TIMEOUT_MS),
    })
    await response.body?.cancel()
    return true
  } catch {
    return false
  }
}

/** 查找常见的 Ollama CLI 安装位置，优先使用显式配置。 */
function findOllamaBinary(): string | undefined {
  const configured = process.env['OLLAMA_BIN']?.trim()
  if (configured !== undefined && configured !== '') return configured

  const names = process.platform === 'win32'
    ? ['ollama.exe', 'ollama.cmd', 'ollama.bat', 'ollama']
    : ['ollama']
  for (const path of (process.env['PATH'] ?? '').split(delimiter)) {
    if (path === '') continue
    for (const name of names) {
      const candidate = join(path, name)
      if (isExecutable(candidate)) return candidate
    }
  }

  const home = homedir()
  const candidates: string[] = []
  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Ollama.app/Contents/Resources/ollama',
      join(home, 'Applications', 'Ollama.app', 'Contents', 'Resources', 'ollama'),
    )
  } else if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA']
    const programFiles = process.env['ProgramFiles']
    const programFilesX86 = process.env['ProgramFiles(x86)']
    if (localAppData !== undefined) candidates.push(join(localAppData, 'Programs', 'Ollama', 'ollama.exe'))
    if (programFiles !== undefined) candidates.push(join(programFiles, 'Ollama', 'ollama.exe'))
    if (programFilesX86 !== undefined) candidates.push(join(programFilesX86, 'Ollama', 'ollama.exe'))
  } else {
    candidates.push(
      '/usr/local/bin/ollama',
      '/usr/bin/ollama',
      join(home, '.local', 'bin', 'ollama'),
    )
  }
  return candidates.find(isExecutable)
}

/** 判断路径是否为可执行文件，忽略权限与缺失错误。 */
function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
