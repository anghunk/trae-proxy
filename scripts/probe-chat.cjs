const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const key = fs.readFileSync(path.join(root, 'keys', 'cn.key'), 'utf8').trim()
const base = 'http://127.0.0.1:39303/v1/chat/completions'
const H = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }

async function run(label, body) {
  console.log(`\n== ${label} ==`)
  const res = await fetch(base, { method: 'POST', headers: H, body: JSON.stringify(body) })
  console.log('http', res.status, res.headers.get('content-type'))
  const text = await res.text()
  if (!res.ok) { console.log(text.slice(0, 600)); return }
  // 收集 content / tool_calls / finish / usage
  let content = ''
  let toolHits = []
  let finish = null
  let usage = null
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '[DONE]') break
    let j
    try { j = JSON.parse(data) } catch { continue }
    const d = j.choices?.[0]?.delta
    if (d?.content) content += d.content
    if (Array.isArray(d?.tool_calls)) {
      for (const tc of d.tool_calls) {
        if (tc.function?.name) toolHits.push(`name=${tc.function.name}`)
        if (tc.function?.arguments) toolHits.push(`args=${tc.function.arguments}`)
      }
    }
    if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason
    if (j.usage) usage = j.usage
  }
  console.log('finish =', finish)
  console.log('content =', JSON.stringify(content.slice(0, 200)))
  if (toolHits.length) console.log('tool_calls:\n  ' + toolHits.join('\n  '))
  console.log('usage =', JSON.stringify(usage))
}

async function main() {
  await run('plain chat (glm-5.3)', {
    model: 'glm-5.3',
    messages: [{ role: 'user', content: 'Reply with exactly: hi' }],
    stream: true,
    max_tokens: 64,
  })
  await run('tool call (glm-5.3)', {
    model: 'glm-5.3',
    messages: [{ role: 'user', content: 'What is the weather in Paris? Use the tool.' }],
    stream: true,
    max_tokens: 300,
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get current weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    }],
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
  })
}
main().catch(e => { console.error(e); process.exit(1) })
