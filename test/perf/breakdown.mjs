// Per-process memory footprint of an idle Welcome window (Activity Monitor style).
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { execSync } from 'child_process'
const app = resolve(import.meta.dirname, '../..')
const ud = mkdtempSync(join(tmpdir(), 'lg-perf-'))
const ea = await electron.launch({ args: [join(app, 'out/main/index.js')], cwd: app, env: { ...process.env, LAGOON_USER_DATA: ud } })
const w = await ea.firstWindow()
await w.getByText('No saved connections yet.').waitFor()
await new Promise((r) => setTimeout(r, 5000))
const lines = execSync('ps -axo pid=,command=', { encoding: 'utf8' }).split('\n').filter((l) => l.includes(join(app, 'node_modules/electron')))
const pids = lines.map((l) => l.trim().split(/\s+/)[0])
const top = execSync(`top -l 1 -stats pid,mem ${pids.map((p) => '-pid ' + p).join(' ')}`, { encoding: 'utf8' })
for (const l of lines) {
  const pid = l.trim().split(/\s+/)[0]
  const mem = new RegExp(`^\\s*${pid}\\s+(\\S+)`, 'm').exec(top)?.[1]
  const type = /--type=(\S+)/.exec(l)?.[1] ?? 'main'
  const sub = /--utility-sub-type=(\S+)/.exec(l)?.[1] ?? ''
  console.log(mem?.padStart(6), type, sub)
}
const heap = await ea.evaluate(() => ({ heapMB: Math.round(process.memoryUsage().heapUsed / 1048576), rssMB: Math.round(process.memoryUsage().rss / 1048576) }))
console.log('main heap', heap)
await ea.close()
rmSync(ud, { recursive: true, force: true })
