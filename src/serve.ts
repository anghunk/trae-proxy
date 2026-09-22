/**
 * trae-proxy 统一网关入口。
 *
 * 默认在 127.0.0.1:39310 启动统一 OpenAI 兼容网关 + React 配置台：
 * - 首次启动自动初始化 SQLite（config/trae-proxy.db）并注册默认 Trae providers；
 * - 定时刷新各 provider 模型目录、清理过期会话；用量明细永久保留；
 * - 管理台保存配置后立即热生效。
 *
 * 仅依赖 Node 内置能力，TypeScript 由 Node 22.19+/24 的类型擦除直接运行。
 *
 * @module trae-proxy/serve
 */

import { mkdirSync } from 'node:fs'
import { createGatewayServer } from './gateway/server.ts'
import { CONFIG_DIR, DEFAULT_DB_PATH, openGatewayStore, type ProviderRecord } from './gateway/store.ts'

const PORT = Number(process.env['TRAE_PROXY_PORT'] ?? 39310)
const HOST = process.env['TRAE_PROXY_HOST'] ?? '127.0.0.1'

function ts(): string {
  return new Date().toISOString()
}

const logger = {
  info: (message: string, detail?: unknown) => {
    process.stdout.write(`[${ts()}] [info] ${message}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}\n`)
  },
  warn: (message: string, detail?: unknown) => {
    process.stderr.write(`[${ts()}] [warn] ${message}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}\n`)
  },
  error: (message: string, detail?: unknown) => {
    process.stderr.write(`[${ts()}] [error] ${message}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}\n`)
  },
}

/** 首次启动写入内置 Trae provider 记录（不覆盖用户已有配置）。 */
function seedDefaultProviders(store: ReturnType<typeof openGatewayStore>): void {
  const now = Date.now()
  const seeds: Array<Omit<ProviderRecord, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'trae-cn',
      type: 'trae-cn',
      name: 'Trae 国内',
      enabled: 1,
      extraHeaders: '{}',
      models: '[]',
      settings: '{}',
    },
    {
      id: 'trae-ai',
      type: 'trae-ai',
      name: 'Trae 国际',
      enabled: 1,
      extraHeaders: '{}',
      models: '[]',
      settings: '{}',
    },
  ]
  for (const seed of seeds) {
    if (store.getProvider(seed.id) !== undefined) continue
    store.upsertProvider({ ...seed, createdAt: now, updatedAt: now })
    logger.info(`已初始化默认 provider: ${seed.id}`)
  }
}

async function main(): Promise<void> {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  const store = openGatewayStore(DEFAULT_DB_PATH)
  seedDefaultProviders(store)

  const server = createGatewayServer({
    store,
    port: PORT,
    host: HOST,
    logger,
  })
  await server.ready

  const reload = await server.reloadProviders()
  logger.info(`provider 已加载：${reload.enabled}/${reload.total} 启用`)
  void server.refreshAllModels().then(results => {
    for (const item of results) {
      if (item.error === undefined) logger.info(`模型目录已刷新: ${item.providerId} (${item.count})`)
      else logger.warn(`模型目录刷新失败: ${item.providerId} (${item.count} 缓存) ${item.error}`)
    }
  })

  const refreshTimer = setInterval(() => {
    void server.refreshAllModels().then(results => {
      for (const item of results) {
        if (item.error === undefined) logger.info(`模型目录已刷新: ${item.providerId} (${item.count})`)
        else logger.warn(`模型目录刷新失败: ${item.providerId} (${item.count} 缓存) ${item.error}`)
      }
    })
  }, 6 * 60 * 60 * 1000)
  refreshTimer.unref()

  const cleanupTimer = setInterval(() => {
    const now = Date.now()
    store.deleteExpiredSessions(now)
  }, 60 * 60 * 1000)
  cleanupTimer.unref()

  logger.info(`统一网关已就绪: ${server.baseUrl()} (healthz=/healthz, models=/v1/models)`)
  logger.info(`管理台: ${server.baseUrl()}/  (首次访问请先创建管理员)`)
  logger.info(`数据库: ${DEFAULT_DB_PATH}`)

  let closing = false
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return
    closing = true
    logger.info(`收到 ${signal}，正在关闭...`)
    clearInterval(refreshTimer)
    clearInterval(cleanupTimer)
    await server.close()
    store.close()
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
}

main().catch((error: unknown) => {
  logger.error('统一网关启动失败', error)
  process.exit(1)
})
