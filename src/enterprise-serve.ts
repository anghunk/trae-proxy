/**
 * 企业版优先的本地代理入口。
 *
 * 启动一个 OpenAI 兼容端点，优先探测企业网关模型目录；
 * 对话仍走已验证的 Solo 通道，避免企业版未完全确认的聊天格式。
 *
 * 运行示例：
 * TRAE_SIGNIN=off node src/enterprise-serve.ts
 *
 * @module trae-proxy/enterprise-serve
 */

import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LiveTraeStore } from './auth.ts'
import { resolveTraeIdentity } from './identity.ts'
import { traeStorageCandidates } from './paths.ts'
import { refreshTraeCredential } from './refresh.ts'
import { regionOfCredential, regionOfEdition, type TraeRegion } from './region.ts'
import { EnterpriseAwareSoloClient, type EnterpriseDiscovery } from './enterprise-solo.ts'
import { fromSoloModels, TraeCatalog } from './catalog.ts'
import { TraeSoloUpstreamClient } from './solo.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const KEYS_DIR = join(ROOT, 'keys')
const PORT = Number(process.env['TRAE_ENT_PORT'] ?? 39305)

function ts(): string {
  return new Date().toISOString()
}

const logger = {
  info: (...args: unknown[]) => process.stdout.write(`[${ts()}] [info] ${args.map(String).join(' ')}\n`),
  warn: (...args: unknown[]) => process.stderr.write(`[${ts()}] [warn] ${args.map(String).join(' ')}\n`),
  error: (...args: unknown[]) => process.stderr.write(`[${ts()}] [error] ${args.map(String).join(' ')}\n`),
}

async function loadOrCreateKey(file: string): Promise<string> {
  try {
    const existing = (await readFile(file, 'utf8')).trim()
    if (existing !== '') return existing
  } catch {
    // first run
  }
  const key = randomBytes(32).toString('base64url')
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, `${key}\n`, { mode: 0o600 })
  return key
}

function bearerOk(req: IncomingMessage, secret: string): boolean {
  const match = typeof req.headers.authorization === 'string'
    ? /^Bearer\s+(.+)$/i.exec(req.headers.authorization.trim())
    : null
  if (match === null) return false
  const actual = Buffer.from(match[1] ?? '')
  const expected = Buffer.from(secret)
  return actual.length === expected.length && Buffer.from(actual).equals(expected)
}

async function readCurrentStorageText(): Promise<string> {
  for (const candidate of traeStorageCandidates()) {
    if (candidate.source !== 'desktop') continue
    try {
      return await readFile(candidate.path, 'utf8')
    } catch {
      // try next candidate
    }
  }
  return ''
}

async function main(): Promise<void> {
  await mkdir(KEYS_DIR, { recursive: true, mode: 0o700 })
  const secret = await loadOrCreateKey(join(KEYS_DIR, 'enterprise.key'))
  const store = new LiveTraeStore({
    region: 'cn',
    refresh: async credential => {
      const candidates = traeStorageCandidates().filter(item =>
        item.source === 'desktop' && regionOfEdition(item.edition) === 'cn' && item.edition === credential.edition)
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

  // 必须是函数：fetchEnterpriseModels 会调用它读取 storage.json（此前误传 Promise）。
  const storageText = () => readCurrentStorageText()
  const identity = async () => {
    const credential = await store.resolve()
    const candidates = traeStorageCandidates().filter(item =>
      item.source === 'desktop' && regionOfCredential(credential) === regionOfEdition(item.edition) && item.edition === credential.edition)
    return resolveTraeIdentity(candidates.length > 0 ? candidates : traeStorageCandidates(), credential.edition)
  }

  const upstream = new EnterpriseAwareSoloClient({
    credential: () => store.resolve(),
    identity,
    storageText,
    log: (message, detail) => logger.warn(message, detail),
  })

  const catalog = new TraeCatalog('cn')
  const server: Server = createServer(async (req, res) => {
    try {
      if (!bearerOk(req, secret)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Missing or invalid bearer', type: 'unauthorized', code: 'unauthorized' } }))
        return
      }
      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, service: 'enterprise-trae-proxy' }))
        return
      }
      if (req.method === 'GET' && (url === '/status' || url === '/status/')) {
        let discovery: EnterpriseDiscovery | undefined
        try { discovery = await upstream.discover() } catch {}
        const auth = await store.status()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ service: 'enterprise-trae-proxy', auth, models: catalog.current().length, discovery }))
        return
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          object: 'list',
          data: catalog.current().map(model => ({ id: model.id, object: 'model', created: 0, owned_by: 'trae-enterprise-cn' })),
        }))
        return
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
        if (typeof req.headers['content-type'] !== 'string' || !req.headers['content-type'].toLowerCase().startsWith('application/json')) {
          res.writeHead(415, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'Content-Type must be application/json', type: 'unsupported_media_type', code: 'unsupported_media_type' } }))
          return
        }
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk)
        const raw = Buffer.concat(chunks).toString('utf8')
        try { JSON.parse(raw) } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'Request body must be valid JSON', type: 'invalid_json', code: 'invalid_json' } }))
          return
        }
        const discovery = await upstream.discover()
        logger.info(`enterprise-proxy 上游: ${discovery.upstreamLabel}`)
        const result = await upstream.chatStream(raw)
        if (!result.ok || result.response === undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: result.message, type: 'upstream_error', code: 'upstream_error' } }))
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        const reader = result.response.body?.getReader()
        if (reader === undefined) {
          res.end()
          return
        }
        const pump = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              if (!res.writableEnded) res.write(value)
            }
          } catch {
            // ignore aborted stream
          } finally {
            try { reader.releaseLock() } catch {}
          }
        }
        await pump()
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `No such route: ${req.method} ${url}`, type: 'not_found', code: 'not_found' } }))
    } catch (error: unknown) {
      logger.error('enterprise-proxy request failed', error)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Internal proxy error', type: 'internal', code: 'internal' } }))
      } else if (!res.writableEnded) {
        res.end()
      }
    }
  })

  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  server.listen(PORT, '127.0.0.1')
  await ready
  logger.info(`enterprise-trae-proxy 已监听 http://127.0.0.1:${PORT}`)

  // 预热模型目录：企业账号的目录只存在于企业网关，公开通道不是同一套，
  // 因此复用 discovery 已解析出的上游基址（企业网关优先）。
  try {
    const catalogClient = new TraeSoloUpstreamClient({
      credential: () => store.resolve(),
      identity,
      baseUrl: async () => (await upstream.discover()).upstreamBase,
      log: (message, detail) => logger.warn(message, detail),
    })
    const models = await catalogClient.fetchModels()
    catalog.set(fromSoloModels(models))
    logger.info(`enterprise-proxy 目录已加载，共 ${models.length} 个`)
  } catch (error: unknown) {
    logger.warn(`enterprise-proxy 目录加载失败：${error instanceof Error ? error.message : error}`)
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`收到 ${signal}，正在关闭...`)
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
}

main().catch((error: unknown) => {
  logger.error('enterprise-trae-proxy 启动失败：', error)
  process.exit(1)
})
