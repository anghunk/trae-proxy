/**
 * 把统一网关注入 opencode.jsonc。
 *
 * 新网关只保留一个 127.0.0.1:39310 OpenAI 兼容端点，模型 id 自带 provider
 * 前缀（如 trae-cn/glm-5.3），API key 由管理台创建，不再使用 keys/*.key 文件。
 *
 * 用法：
 *   1. 先启动网关并在管理台创建管理员 + API key；
 *   2. 把 key 写入环境变量 TRAE_PROXY_KEY（避免留在终端历史）：
 *      TRAE_PROXY_KEY=tr-xxxxxxxx node scripts/inject-config.cjs
 *   3. 重启 opencode 生效。
 */

const fs = require('node:fs')
const path = require('node:path')

const cfgPath = path.join(__dirname, '..', '..', 'opencode.jsonc')
const gatewayBase = process.env['TRAE_PROXY_BASE'] || 'http://127.0.0.1:39310'
const gatewayKey = process.env['TRAE_PROXY_KEY'] || ''

function readConfig() {
  const raw = fs.readFileSync(cfgPath, 'utf8')
  if (raw.trimStart().startsWith('{')) return JSON.parse(raw)
  return JSON.parse(raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))
}

async function fetchModels() {
  if (gatewayKey === '') return undefined
  const res = await fetch(`${gatewayBase}/v1/models`, {
    headers: { Authorization: `Bearer ${gatewayKey}` },
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) return undefined
  return (await res.json()).data
}

async function main() {
  const cfg = readConfig()
  const models = await fetchModels()
  const provider = models === undefined ? undefined : {
    npm: '@ai-sdk/openai-compatible',
    name: 'Trae Proxy 统一网关',
    options: {
      baseURL: `${gatewayBase}/v1`,
      ...(gatewayKey === '' ? {} : { apiKey: gatewayKey }),
    },
    ...(models === undefined ? {} : { models: models.map(m => ({ id: m.id })) }),
  }
  cfg.provider = cfg.provider || {}
  cfg.provider['trae-proxy'] = provider
  fs.copyFileSync(cfgPath, cfgPath + '.bak.trae')
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8')

  if (models === undefined) {
    console.log(`[${gatewayBase}] 网关不可用或未设置 TRAE_PROXY_KEY，已注入无 apiKey 的 provider`)
    console.log('  请启动网关并创建 API key 后重试，否则 opencode 会提示缺少凭据。')
  } else {
    console.log(`[${gatewayBase}] 注入 ${models.length} 个模型（id 已带 provider 前缀）`)
  }
  console.log('已备份 opencode.jsonc.bak.trae')
}

main().catch(e => { console.error(e); process.exit(1) })
