const fs = require('node:fs')
const path = require('node:path')
const d = path.join(__dirname, 'scripts')
for (const f of fs.readdirSync(d).filter(x => x.endsWith('.ps1'))) {
  const fp = path.join(d, f)
  let t = fs.readFileSync(fp, 'utf8')
  if (t.charCodeAt(0) !== 0xFEFF) {
    fs.writeFileSync(fp, '\uFEFF' + t, 'utf8')
    console.log('BOM added', f)
  }
}
