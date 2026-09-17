const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const key = fs.readFileSync(path.join(root, 'keys', 'cn.key'), 'utf8').trim()
async function main() {
  const ml = await (await fetch('http://127.0.0.1:39303/v1/models', { headers: { Authorization: `Bearer ${key}` } })).json()
  console.log(JSON.stringify(ml.data.map(m => m.id)))
}
main()
