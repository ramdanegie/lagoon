// Automation: saved tasks run on their schedule while Lagoon is open (missed runs run once at the next start).
// Each run opens its own connection with the saved password; tasks on connections that ask for a password are refused.
import { app, BrowserWindow, Notification } from 'electron'
import { join } from 'path'
import type { SqlDriver } from './drivers/types'
import { nextRun, type AutoRun, type AutoTask } from '@shared/automation'
import { splitStatements } from '@shared/split'
import { CSV_DEFAULTS, expandPattern } from '@shared/importexport'
import { MASK_PRESETS, type MaskRule } from '@shared/masking'
import { register } from './rpc'
import { buildDriver, resolvePassword } from './sessions'
import { getConnection, getSetting, secretsOf, setSetting } from './store'
import { approve, exportItems, isApproved, type JobCtl } from './jobs'
import { findTools, runTool } from './backup'

const KEEP_RUNS = 100
const MAX_LOG = 20000
let tasks: AutoTask[] = []
let runs: AutoRun[] = []
let loaded = false
/** The store opens once the app is ready, after this module loads. */
const load = (): void => {
  if (loaded) return
  loaded = true
  tasks = getSetting<AutoTask[]>('automation.tasks', [])
  runs = getSetting<AutoRun[]>('automation.runs', [])
}
const running = new Set<string>()

const changed = (): void => {
  setSetting('automation.tasks', tasks)
  setSetting('automation.runs', runs)
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('automation:changed')
}
const state = (): { tasks: AutoTask[]; runs: AutoRun[]; running: string[] } => { load(); return { tasks, runs, running: [...running] } }

async function execute(t: AutoTask, log: (s: string) => void): Promise<{ message: string; output?: string }> {
  const c = getConnection(t.connectionId)
  if (c.passwordMode === 'ask' || (c.ssh?.enabled && c.ssh.passwordMode === 'ask')) throw new Error(`${c.name} asks for its password every time, so it cannot run unattended. Save the password in the connection to automate it.`)
  const database = t.database || c.database
  const j: JobCtl = { cancelled: false, progress: () => {}, log }
  const a = t.action
  const tokens = { connection: c.name, database }
  if (a.type === 'backup') {
    if (c.driver !== 'postgres' && c.driver !== 'mysql' && c.driver !== 'mariadb') throw new Error('Backups need a PostgreSQL, MySQL or MariaDB connection.')
    const [tool] = await findTools(c.driver === 'postgres' ? 'pg' : 'my')
    if (!tool) throw new Error(`${c.driver === 'postgres' ? 'pg_dump' : 'mysqldump'} was not found. Install it, or point Lagoon to it once in File ▸ Backup Database.`)
    const file = join(a.folder, expandPattern(a.pattern || '{database}_{date}_{time}', tokens) + (a.gzip ? '.sql.gz' : '.sql'))
    approve(file)
    return runTool(j, { connectionId: c.id, database: database ?? '', tool: tool.path, options: '', file, gzip: a.gzip }, 'backup')
  }
  const { driver, tunnel } = await buildDriver({ ...c, database }, { ...secretsOf(c.id), password: resolvePassword(c) })
  try {
    if (!('dialect' in driver)) throw new Error('Only SQL connections can run this task.')
    const d = driver as SqlDriver
    if (a.type === 'sql') {
      const stmts = splitStatements(a.sql, d.dialect)
      if (!stmts.length) throw new Error('The task has no SQL to run.')
      for (const [i, s] of stmts.entries()) {
        const r = await d.query(s.sql)
        log(`${i + 1}. ${s.sql.split('\n')[0].slice(0, 120)} · ${r.affected ?? r.rows.length} row${(r.affected ?? r.rows.length) === 1 ? '' : 's'}\n`)
      }
      return { message: `Ran ${stmts.length} statement${stmts.length === 1 ? '' : 's'}` }
    }
    const all = (await d.objects(a.schema)).filter((o) => o.kind === 'table' || o.kind === 'view' || o.kind === 'matview')
    const items = a.tables.length ? all.filter((o) => a.tables.includes(o.name)) : all.filter((o) => o.kind === 'table')
    const missing = a.tables.filter((n) => !all.some((o) => o.name === n))
    if (missing.length) log(`Not found, skipped: ${missing.join(', ')}\n`)
    if (!items.length) throw new Error('None of the task\'s tables exist.')
    const sqlFile = a.format === 'sql' ? join(a.folder, expandPattern(a.pattern || '{database}_{date}_{time}', { ...tokens, schema: a.schema }) + '.sql') : undefined
    approve(sqlFile ?? a.folder)
    const mask = a.mask ? getSetting<MaskRule[]>('masking.rules', MASK_PRESETS) : undefined
    return await exportItems(j, c, d, { items, format: a.format, target: sqlFile ?? a.folder, pattern: a.pattern || '{table}_{date}_{time}', csv: { ...CSV_DEFAULTS, header: true }, pretty: true, sql: {}, gzip: false, mask })
  } finally {
    await driver.close().catch(() => {})
    tunnel?.server.close()
    tunnel?.ssh.end()
  }
}

async function runTask(id: string): Promise<void> {
  load()
  const t = tasks.find((x) => x.id === id)
  if (!t || running.has(id)) return
  running.add(id)
  // the next slot is fixed before running, so a slow run never makes the schedule fire twice
  t.nextAt = t.enabled ? nextRun(t.schedule, Date.now()) : null
  changed()
  const start = Date.now()
  let log = ''
  const add = (s: string): void => { if (log.length < MAX_LOG) log += s }
  let run: AutoRun
  try {
    const r = await execute(t, add)
    run = { taskId: id, name: t.name, start, end: Date.now(), ok: true, message: r.message, log, output: r.output }
  } catch (e) {
    run = { taskId: id, name: t.name, start, end: Date.now(), ok: false, message: (e as Error).message, log }
    if (Notification.isSupported()) new Notification({ title: `Task failed: ${t.name}`, body: run.message }).show()
  }
  running.delete(id)
  runs = [run, ...runs].slice(0, KEEP_RUNS)
  changed()
}

function tick(): void {
  load()
  const now = Date.now()
  for (const t of tasks) if (t.enabled && t.nextAt && t.nextAt <= now) void runTask(t.id)
}
void app.whenReady().then(() => {
  setInterval(tick, 20000)
  setTimeout(tick, 5000) // runs missed while Lagoon was closed
})

register({
  'automation.list': () => state(),
  'automation.save': (_c, t: AutoTask) => {
    load()
    const old = tasks.find((x) => x.id === t.id)
    const a = t.action
    // folders come from the folder picker; an unchanged saved folder stays trusted
    if (a.type !== 'sql' && !isApproved(a.folder) && !(old && old.action.type !== 'sql' && old.action.folder === a.folder)) throw new Error('Choose the folder with the folder picker.')
    getConnection(t.connectionId)
    const task: AutoTask = { ...t, id: t.id || crypto.randomUUID(), name: t.name.trim() || 'Untitled task', nextAt: t.enabled ? nextRun(t.schedule, Date.now()) : null }
    tasks = old ? tasks.map((x) => (x.id === task.id ? task : x)) : [...tasks, task]
    changed()
    return task
  },
  'automation.delete': (_c, id: string) => { load(); tasks = tasks.filter((x) => x.id !== id); changed() },
  'automation.run': (_c, id: string) => void runTask(id),
  'automation.clearHistory': () => { runs = []; changed() }
})
