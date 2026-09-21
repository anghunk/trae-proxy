const fs = require('node:fs')
const path = require('node:path')

const cfgPath = path.join(__dirname, '..', '..', 'opencode.jsonc')
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
cfg.provider = cfg.provider || {}

const K = path.join(__dirname, '..', 'keys').replace(/\\/g, '/')
const keyFile = (f) => `{file:${K}/${f}}`
const lim = (context, output = 32768) => ({ context, output })
const text = () => ({ modalities: { input: ['text'], output: ['text'] } })

function entry(name, context) {
  return { name, limit: lim(context), ...text() }
}

// 仅纳入正规对话模型（排除 custom_model_* 占位与 *_subagent/file_search 等内部 agent）
// 注意：这只是元数据表（显示名 / 上下文长度），实际注入时会与代理实时目录取交集。
const STATIC_CN_MODELS = {
  'glm-5.3': entry('GLM-5.3 (Trae)', 200000),
  'glm-5.2': entry('GLM-5.2 (Trae)', 200000),
  'glm-5-turbo': entry('GLM-5-Turbo (Trae)', 128000),
  'DeepSeek-V4-Pro-Official': entry('DeepSeek-V4-Pro (Trae)', 200000),
  'DeepSeek-V4-Flash-Official': entry('DeepSeek-V4-Flash (Trae)', 200000),
  'kimi-k3': entry('Kimi-K3 (Trae)', 200000),
  'kimi-k2.7-code': entry('Kimi-K2.7-Code (Trae)', 200000),
  'kimi-k2.6': entry('Kimi-K2.6 (Trae)', 200000),
  'Doubao-Seed-2.1-Pro': entry('Doubao-Seed-2.1-Pro (Trae)', 200000),
  'Doubao-Seed-2.1-Turbo': entry('Doubao-Seed-2.1-Turbo (Trae)', 200000),
  'Doubao-Seed-2.0-Code': entry('Doubao-Seed-2.0-Code (Trae)', 200000),
  'Doubao-Seed-Evolving': entry('Doubao-Seed-Evolving (Trae)', 200000),
  'seed-code-pro-0430': entry('Seed-Code-Pro-0430 (Trae)', 200000),
  'minimax-m3': entry('MiniMax-M3 (Trae)', 200000),
  'qwen3.8-max': entry('Qwen3.8-Max (Trae)', 200000),
  'qwen-3.7-plus': entry('Qwen-3.7-Plus (Trae)', 128000),
  'sagitta': entry('Sagitta (Trae)', 128000),
  'aquila': entry('Aquila (Trae)', 128000),
}

const STATIC_AI_MODELS = {
  'gpt-5.4': entry('GPT-5.4 (Trae国际)', 272000),
  'gpt-5.2': entry('GPT-5.2 (Trae国际)', 272000),
  'gemini-3.1-pro': entry('Gemini-3.1-Pro (Trae国际)', 200000),
  'minimax-m3': entry('MiniMax-M3 (Trae国际)', 200000),
}

/**
 * 用代理实时目录过滤静态表。
 *
 * 企业版与个人版的模型目录不是同一套（企业版走企业网关，id 大小写都不同），
 * 直接注入静态表会把不存在的模型列进 opencode，选中后必然 404。
 * 代理未启动 / 未登录时原样返回静态表，保持原有行为。
 */
async function filterByLive(models, baseURL, keyName) {
  try {
    const key = fs.readFileSync(path.join(__dirname, '..', 'keys', keyName), 'utf8').trim()
    const res = await fetch(`${baseURL}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return models
    const live = new Set((await res.json()).data.map((m) => m.id))
    const kept = Object.fromEntries(Object.entries(models).filter(([id]) => live.has(id)))
    if (Object.keys(kept).length === 0) return models
    const skipped = Object.keys(models).filter((id) => !live.has(id))
    const missing = [...live].filter((id) => !(id in models) && !id.startsWith('custom_model_') && id !== 'summary')
    console.log(`[${baseURL}] 注入 ${Object.keys(kept).length} 个模型`)
    if (skipped.length > 0) console.log(`  目录中不存在，已跳过: ${skipped.join(', ')}`)
    if (missing.length > 0) console.log(`  目录中存在但静态表没有元数据，未注入: ${missing.join(', ')}`)
    return kept
  } catch {
    console.log(`[${baseURL}] 代理不可用，使用静态模型表`)
    return models
  }
}

async function main() {
  cfg.provider['trae-cn'] = {
    npm: '@ai-sdk/openai-compatible',
    name: 'Trae 国内版',
    options: {
      baseURL: 'http://127.0.0.1:39303/v1',
      apiKey: keyFile('cn.key'),
    },
    models: await filterByLive(STATIC_CN_MODELS, 'http://127.0.0.1:39303', 'cn.key'),
  }

  cfg.provider['trae-ai'] = {
    npm: '@ai-sdk/openai-compatible',
    name: 'Trae 国际版',
    options: {
      baseURL: 'http://127.0.0.1:39304/v1',
      apiKey: keyFile('ai.key'),
    },
    models: await filterByLive(STATIC_AI_MODELS, 'http://127.0.0.1:39304', 'ai.key'),
  }

  fs.copyFileSync(cfgPath, cfgPath + '.bak.trae')
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  console.log('trae providers injected; backup opencode.jsonc.bak.trae')
}

main().catch((e) => { console.error(e); process.exit(1) })
