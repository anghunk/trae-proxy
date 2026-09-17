/**
 * trae-proxy 守护入口：一个进程同时服务国内(cn)与国际(ai)两个回环端点。
 *
 * 改自 dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）。
 * 仅依赖 Node 内置能力，TypeScript 由 Node 22.19+/24 的类型擦除直接运行，无需构建。
 *
 * @module trae-proxy/serve
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LiveTraeStore } from './auth.ts'
import { fromSoloModels, TraeCatalog } from './catalog.ts'
import { resolveTraeIdentity } from './identity.ts'
import { traeStorageCandidates } from './paths.ts'
import { refreshTraeCredential } from './refresh.ts'
import { regionOfCredential, regionOfEdition, type TraeRegion } from './region.ts'
import { createTraeShim, type TraeShim, type ShimLogger } from './shim.ts'
import { TraeSoloBridge } from './solo-bridge.ts'
import { TraeSoloUpstreamClient } from './solo.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const KEYS_DIR = join(ROOT, 'keys')

const REGION_PORTS: Record<TraeRegion, number> = {
  cn: Number(process.env['TRAE_CN_PORT'] ?? 39303),
  ai: Number(process.env['TRAE_AI_PORT'] ?? 39304),
}

function ts(): string {
  return new Date().toISOString()
}

const logger: ShimLogger = {
  info: (...args) => process.stdout.write(`[${ts()}] [info] ${args.map(String).join(' ')}\n`),
  warn: (...args) => process.stderr.write(`[${ts()}] [warn] ${args.map(String).join(' ')}\n`),
  error: (...args) => process.stderr.write(`[${ts()}] [error] ${args.map(String).join(' ')}\n`),
}

async function loadOrCreateKey(file: string): Promise<string> {
  try {
    const existing = (await readFile(file, 'utf8')).trim()
    if (existing !== '') return existing
  } catch {
    // 不存在则生成
  }
  const key = randomBytes(32).toString('base64url')
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, `${key}\n`, { mode: 0o600 })
  return key
}

interface RegionRuntime {
  region: TraeRegion
  store: LiveTraeStore
  solo: TraeSoloUpstreamClient
  catalog: TraeCatalog
}

async function refreshModels(rt: RegionRuntime): Promise<void> {
  try {
    const models = await rt.solo.fetchModels()
    if (models.length > 0) {
      rt.catalog.set(fromSoloModels(models))
      logger.info(`trae(${rt.region}): 模型目录已刷新，共 ${models.length} 个`)
    }
  } catch (error: unknown) {
    logger.warn(`trae(${rt.region}): 模型目录刷新失败，使用内置 fallback（${String(error instanceof Error ? error.message : error)}）`)
  }
}

async function buildRegion(region: TraeRegion): Promise<{ shim: TraeShim; rt: RegionRuntime }> {
  const store = new LiveTraeStore({
    region,
    refresh: async credential => {
      const candidates = traeStorageCandidates().filter(item =>
        item.source === 'desktop' && regionOfEdition(item.edition) === region
        && item.edition === credential.edition)
      let device: { deviceId: string; machineId: string } | undefined
      try {
        const id = await resolveTraeIdentity(candidates.length > 0 ? candidates : traeStorageCandidates(), credential.edition)
        device = { deviceId: id.deviceId, machineId: id.machineId }
      } catch {
        device = undefined
      }
      return refreshTraeCredential(credential, undefined, device)
    },
  })

  const identity = async () => {
    const credential = await store.resolve()
    const candidates = traeStorageCandidates().filter(item =>
      item.source === 'desktop' && regionOfCredential(credential) === regionOfEdition(item.edition)
      && item.edition === credential.edition)
    return resolveTraeIdentity(candidates.length > 0 ? candidates : traeStorageCandidates(), credential.edition)
  }

  const solo = new TraeSoloUpstreamClient({
    credential: () => store.resolve(),
    identity,
    log: (message, detail) => logger.warn(message, detail),
  })

  const catalog = new TraeCatalog(region)
  const bridge = new TraeSoloBridge(solo, catalog)
  const rt: RegionRuntime = { region, store, solo, catalog }

  const key = await loadOrCreateKey(join(KEYS_DIR, `${region}.key`))
  const shim = createTraeShim({
    region,
    port: REGION_PORTS[region],
    token: key,
    store,
    client: bridge,
    catalog,
    logger,
  })
  return { shim, rt }
}

async function main(): Promise<void> {
  await mkdir(KEYS_DIR, { recursive: true, mode: 0o700 })
  const runtimes: RegionRuntime[] = []
  const shims: TraeShim[] = []

  for (const region of ['cn', 'ai'] as TraeRegion[]) {
    const built = await buildRegion(region)
    await built.shim.ready
    shims.push(built.shim)
    runtimes.push(built.rt)
    logger.info(`trae(${region}) 已监听 ${built.shim.baseUrl()} (models=${built.rt.catalog.current().length})`)
    void refreshModels(built.rt)
  }

  const timer = setInterval(() => {
    for (const rt of runtimes) void refreshModels(rt)
  }, 6 * 60 * 60 * 1000)
  timer.unref()

  logger.info(`trae-proxy 就绪：国内 ${REGION_PORTS.cn} / 国际 ${REGION_PORTS.ai}`)

  let closing = false
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return
    closing = true
    logger.info(`收到 ${signal}，正在关闭...`)
    clearInterval(timer)
    await Promise.allSettled(shims.map(shim => shim.close()))
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
}

main().catch((error: unknown) => {
  logger.error('trae-proxy 启动失败：', error)
  process.exit(1)
})
