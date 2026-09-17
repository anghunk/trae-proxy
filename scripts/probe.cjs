const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const key = fs.readFileSync(path.join(root, 'keys', 'cn.key'), 'utf8').trim()
const base = 'http://127.0.0.1:39303'
const H = { Authorization: `Bearer ${key}` }

async function main() {
  console.log('== healthz ==')
  console.log(await (await fetch(`${base}/healthz`, { headers: H })).text())

  console.log('== status ==')
  const st = await (await fetch(`${base}/status`, { headers: H })).json()
  console.log(JSON.stringify({ ...st, auth: { ...st.auth } }, null, 2))

  console.log('== models (count + first 12) ==')
  const ml = await (await fetch(`${base}/v1/models`, { headers: H })).json()
  console.log('total =', ml.data.length)
  console.log(ml.data.slice(0, 12).map(m => m.id).join('\n'))
}
main().catch(e => { console.error(e); process.exit(1) })
