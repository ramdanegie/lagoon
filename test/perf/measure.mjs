// Performance probe: cold start, idle memory (all processes, RSS), memory with a 10k-row table open, scroll frame times.
// Usage: npx electron-vite build && node test/perf/measure.mjs [--compare]   (--compare also measures TablePlus / Navicat if installed)
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, rmSync, statSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { execSync } from 'child_process'
import { DatabaseSync } from 'node:sqlite'

const app = resolve(import.meta.dirname, '../..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mb = (kb) => Math.round(kb / 1024)

/** Sum RSS (KB) of every process whose command line contains `needle`. */
function rssOf(needle) {
  const out = execSync('ps -axo rss=,command=', { encoding: 'utf8' })
  return out.split('\n').filter((l) => l.includes(needle) && !l.includes('ps -axo')).reduce((a, l) => a + Number(l.trim().split(/\s+/)[0] || 0), 0)
}

/** Activity Monitor style memory (physical footprint, from `top`) summed over matching processes, in MB. */
function footprintOf(needle) {
  const pids = execSync('ps -axo pid=,command=', { encoding: 'utf8' }).split('\n').filter((l) => l.includes(needle) && !l.includes('ps -axo')).map((l) => l.trim().split(/\s+/)[0]).filter(Boolean)
  if (!pids.length) return 0
  const out = execSync(`top -l 1 -stats pid,mem ${pids.map((p) => '-pid ' + p).join(' ')}`, { encoding: 'utf8' })
  let total = 0
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+([\d.]+)([KMG])/.exec(line)
    if (m && pids.includes(m[1])) total += Number(m[2]) * ({ K: 1 / 1024, M: 1, G: 1024 })[m[3]]
  }
  return Math.round(total)
}

function breakdown(needle) {
  const lines = execSync('ps -axo pid=,command=', { encoding: 'utf8' }).split('\n').filter((l) => l.includes(needle) && !l.includes('ps -axo'))
  const pids = lines.map((l) => l.trim().split(/\s+/)[0])
  const top = execSync(`top -l 1 -stats pid,mem ${pids.map((p) => '-pid ' + p).join(' ')}`, { encoding: 'utf8' })
  return Object.fromEntries(lines.map((l) => { const pid = l.trim().split(/\s+/)[0]; return [(/--type=(\S+)/.exec(l)?.[1] ?? 'main') + ':' + pid, new RegExp(`^\\s*${pid}\\s+(\\S+)`, 'm').exec(top)?.[1]] }))
}

function dirSize(d) {
  let n = 0
  for (const e of readdirSync(d, { withFileTypes: true })) n += e.isDirectory() ? dirSize(join(d, e.name)) : statSync(join(d, e.name)).size
  return n
}

const tmp = mkdtempSync(join(tmpdir(), 'tc-perf-'))
const dbFile = join(tmp, 'big.sqlite')
const db = new DatabaseSync(dbFile)
db.exec('create table big (id integer primary key, name text, email text, city text, amount real, note text, created_at text)')
const ins = db.prepare('insert into big (name, email, city, amount, note, created_at) values (?,?,?,?,?,?)')
db.exec('begin')
for (let i = 1; i <= 10000; i++) ins.run(`Name ${i}`, `user${i}@example.com`, ['Jakarta', 'Bandung', 'Surabaya', 'Medan'][i % 4], i * 1.25, 'lorem ipsum dolor sit amet '.repeat(2), '2026-11-07 10:00:00')
db.exec('commit')
db.close()

const results = {}
const t0 = Date.now()
const ea = await electron.launch({ args: [join(app, 'out/main/index.js')], cwd: app, env: { ...process.env, LAGOON_USER_DATA: join(tmp, 'ud') } })
const welcome = await ea.firstWindow()
await welcome.getByText('No connections yet.').waitFor()
results.coldStartMs = Date.now() - t0
await sleep(4000)
const needle = join(app, 'node_modules/electron')
results.idleWelcomeMB = { rss: mb(rssOf(needle)), footprint: footprintOf(needle) }

// one window: save the connection, open it from the tree, click the table (the real flow)
await welcome.evaluate(async (f) => {
  await window.api.call('conn.save', { id: '', name: 'Perf SQLite', driver: 'sqlite', filePath: f, passwordMode: 'none', safeMode: 0 })
  window.dispatchEvent(new CustomEvent('connections:changed'))
}, dbFile)
const ws = welcome
const tOpen = Date.now()
await ws.getByRole('treeitem', { name: 'Perf SQLite' }).dblclick()
await ws.getByRole('treeitem', { name: 'big', exact: true }).click()
await ws.getByText(/of 10,000 rows/).waitFor()
results.openTable10kMs = Date.now() - tOpen
await sleep(3000)
results.workspaceWithTableMB = { rss: mb(rssOf(needle)), footprint: footprintOf(needle), perProcess: breakdown(needle) }

// scroll the grid for ~2s and record frame intervals
results.scroll = await ws.evaluate(async () => {
  const g = document.querySelector('.grid')
  const frames = []
  let last = performance.now()
  const end = last + 2000
  await new Promise((done) => {
    const step = (t) => { frames.push(t - last); last = t; g.scrollTop += 120; if (t < end) requestAnimationFrame(step); else done() }
    requestAnimationFrame(step)
  })
  frames.shift()
  frames.sort((a, b) => a - b)
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length
  return { frames: frames.length, avgMs: +avg.toFixed(1), p95Ms: +frames[Math.floor(frames.length * 0.95)].toFixed(1), maxMs: +frames[frames.length - 1].toFixed(1), over33ms: frames.filter((f) => f > 33).length, fps: Math.round(1000 / avg) }
})
await ea.close()

results.bundle = {
  rendererKB: Math.round(dirSize(join(app, 'out/renderer')) / 1024),
  mainKB: Math.round(dirSize(join(app, 'out/main')) / 1024),
  preloadKB: Math.round(dirSize(join(app, 'out/preload')) / 1024)
}
rmSync(tmp, { recursive: true, force: true })

if (process.argv.includes('--compare')) {
  for (const [label, appName, bundle] of [['TablePlus', 'TablePlus', '/Applications/TablePlus.app'], ['Navicat Premium Lite', 'Navicat Premium Lite', '/Applications/Navicat Premium Lite.app']]) {
    try { statSync(bundle) } catch { continue }
    if (rssOf(bundle + '/Contents/MacOS')) { results[label] = 'already running, not measured'; continue }
    const s = Date.now()
    execSync(`open -g -a "${appName}"`)
    let kb = 0
    for (let i = 0; i < 40 && !kb; i++) { await sleep(250); kb = rssOf(bundle + '/Contents') }
    await sleep(8000)
    results[label] = { idleMB: { rss: mb(rssOf(bundle + '/Contents')), footprint: footprintOf(bundle + '/Contents') } }
    try { execSync(`osascript -e 'tell application "${appName}" to quit'`) } catch { /* ignore */ }
    await sleep(1500)
  }
}
console.log(JSON.stringify(results, null, 2))
