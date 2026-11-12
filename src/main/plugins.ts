// JS plugin host: bundles live in <userData>/plugins/<id>/ and run in a fresh node:vm context per command.
// Also: app version / data path and the app-wide passcode lock state (Settings > Security).
import { app, BrowserWindow, type WebContents, systemPreferences } from 'electron'
import { basename, join, resolve, sep } from 'path'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import vm from 'node:vm'
import { validateManifest, emptyActions, type PluginActions, type PluginCtxData, type PluginInfo, type PluginList } from '@shared/plugin'
import { isReadOnly, splitStatements } from '@shared/split'
import { dialectOf } from '@shared/types'
import { register } from './rpc'
import { session, sqlDriver } from './sessions'
import { addHistory, getSetting } from './store'

const SOURCE = '.lagoon-source' // remembers the folder a plugin was installed from, for Reinstall
const pluginsDir = (): string => join(app.getPath('userData'), 'plugins')
/** Packaged builds ship examples as extraResources; in dev they sit next to package.json. */
const examplesDir = (): string | undefined =>
  [join(process.resourcesPath, 'plugins-examples'), join(app.getAppPath(), 'plugins-examples')].find((d) => existsSync(d))

const subdirs = (d: string | undefined): string[] =>
  d && existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(d, e.name)) : []

function readPlugin(dir: string): PluginInfo {
  try {
    const m = validateManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')))
    if (!existsSync(join(dir, m.script))) throw new Error(`The script "${m.script}" is missing`)
    return { ...m, path: dir }
  } catch (e) {
    const name = basename(dir)
    return { id: name, name, version: '', script: '', commands: [], path: dir, error: (e as Error).message }
  }
}

const installed = (): PluginInfo[] => subdirs(pluginsDir()).map(readPlugin)

function list(): PluginList {
  const mine = installed()
  const ids = new Set(mine.map((p) => p.id))
  return { dir: pluginsDir(), installed: mine, available: subdirs(examplesDir()).map(readPlugin).filter((p) => !p.error && !ids.has(p.id)) }
}

/** Plain files and folders only: symlinks are skipped, node_modules/.git are not needed (scripts cannot require). */
function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    if (e.isDirectory()) copyDir(join(from, e.name), join(to, e.name))
    else if (e.isFile()) writeFileSync(join(to, e.name), readFileSync(join(from, e.name)))
  }
}

function install(folder: string): PluginList {
  const src = resolve(folder)
  const p = readPlugin(src)
  if (p.error) throw new Error(p.error)
  const dest = resolve(pluginsDir(), p.id)
  if (src === dest || src.startsWith(dest + sep)) throw new Error('Choose the original plugin folder, not the installed copy')
  rmSync(dest, { recursive: true, force: true })
  copyDir(src, dest)
  writeFileSync(join(dest, SOURCE), src)
  return list()
}

const findInstalled = (id: string): PluginInfo => {
  const p = installed().find((x) => x.id === id)
  if (!p) throw new Error(`Plugin ${id} is not installed`)
  return p
}

function reinstall(id: string): PluginList {
  const p = findInstalled(id)
  const recorded = existsSync(join(p.path, SOURCE)) ? readFileSync(join(p.path, SOURCE), 'utf8').trim() : ''
  const example = subdirs(examplesDir()).find((d) => readPlugin(d).id === id)
  const src = [recorded, example].find((d) => d && existsSync(join(d, 'manifest.json')))
  if (!src) throw new Error('The folder this plugin was installed from no longer exists. Use "Install from Folder…" instead.')
  return install(src)
}

// ---------- running ----------
const pending = new Map<string, (ok: boolean) => void>()

/** Ask the window that ran the command to confirm a statement (it applies the connection's safe mode). */
function confirmInRenderer(sender: WebContents, sql: string, plugin: string): Promise<boolean> {
  if (sender.isDestroyed()) return Promise.resolve(false)
  const token = randomUUID()
  return new Promise((res) => {
    const gone = (): void => done(false)
    const done = (ok: boolean): void => { pending.delete(token); sender.off('destroyed', gone); res(ok) }
    pending.set(token, done)
    sender.once('destroyed', gone)
    sender.send('plugin:confirm', token, sql, plugin)
  })
}

async function pluginQuery(sender: WebContents, sessionId: string | undefined, sql: unknown, plugin: string): Promise<unknown> {
  if (typeof sql !== 'string' || !sql.trim()) throw new Error('db.query(sql) needs an SQL string')
  if (!sessionId) throw new Error('db.query needs an open database connection')
  const s = session(sessionId)
  const d = sqlDriver(sessionId)
  const level = s.conn.safeMode ?? 0
  // every statement must be read-only, otherwise "select 1; drop table x" would slip through
  const writes = !splitStatements(sql, d.dialect).every((st) => isReadOnly(st.sql))
  if ((writes || level === 1 || level === 3) && !(await confirmInRenderer(sender, sql, plugin))) throw new Error('The statement was cancelled')
  const t = Date.now()
  const log = (error?: string): void => addHistory({ connectionId: s.conn.id, database: d.currentDatabase(), sql, source: 'plugin', durationMs: Date.now() - t, error })
  try {
    const r = await d.query(sql)
    log()
    const names = r.columns.map((c) => c.name)
    return { columns: names, rows: r.rows.map((row) => Object.fromEntries(names.map((n, i) => [n, row[i]]))), rowCount: r.rowCount, affected: r.affected ?? null }
  } catch (e) {
    log((e as Error).message)
    throw e
  }
}

const TIMEOUT = 5000
const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v))

// node:vm keeps plugins away from require/process by default but is not a security boundary;
// the install dialog warns that plugins are trusted code that can read and change data.
async function run(sender: WebContents, id: string, commandId: string, data: PluginCtxData = {}, sessionId?: string): Promise<PluginActions> {
  const p = findInstalled(id)
  if (p.error) throw new Error(`${p.name}: ${p.error}`)
  const cmd = p.commands.find((c) => c.id === commandId)
  if (!cmd) throw new Error(`${p.name} has no command "${commandId}"`)
  const code = readFileSync(join(p.path, p.script), 'utf8')
  let dialect: string | null = null
  try { if (sessionId) dialect = dialectOf(session(sessionId).conn.driver) ?? null } catch { /* closed session: dialect stays null */ }
  const out = emptyActions()
  const context = {
    clickedRow: () => data.row ?? null,
    clickedColumn: () => data.column ?? null,
    clickedRowValue: () => data.value ?? null,
    selectedTable: () => data.table ?? null,
    currentItem: () => data.item ?? data.table ?? null,
    selectedRows: () => data.rows ?? (data.row ? [data.row] : []),
    editorText: () => data.editorText ?? null,
    editorSelection: () => data.editorSelection ?? null,
    dialect: () => dialect
  }
  const mod = { exports: {} as Record<string, unknown> }
  const sandbox: Record<string, unknown> = {
    context,
    SystemService: {
      insertToClipboard: (t: unknown) => { out.clipboard = str(t) },
      notify: (title: unknown, body: unknown) => { out.notifications.push({ title: str(title), body: str(body) }) }
    },
    actions: {
      setCellValue: (v: unknown) => { out.cellValue = v === null ? null : str(v) },
      setEditorText: (t: unknown) => { out.editorText = str(t) },
      replaceEditorSelection: (t: unknown) => { out.editorSelection = str(t) }
    },
    db: { query: (sql: unknown) => pluginQuery(sender, sessionId, sql, p.name) },
    crypto: { randomUUID: () => randomUUID() },
    console: { log: (...a: unknown[]) => console.log(`[plugin ${p.id}]`, ...a), error: (...a: unknown[]) => console.error(`[plugin ${p.id}]`, ...a) },
    module: mod,
    exports: mod.exports
  }
  try {
    const ctx = vm.createContext(sandbox, { name: p.id, codeGeneration: { strings: false, wasm: false } })
    new vm.Script(code, { filename: `${p.id}/${p.script}` }).runInContext(ctx, { timeout: TIMEOUT })
    const fn = typeof mod.exports[cmd.handler] === 'function' ? mod.exports[cmd.handler] : sandbox[cmd.handler]
    if (typeof fn !== 'function') throw new Error(`handler "${cmd.handler}" is not defined in ${p.script}`)
    sandbox.__handler = fn
    // the sync part is bounded by the vm timeout; an async handler is awaited (db.query may wait for the user)
    await vm.runInContext('__handler(context)', ctx, { timeout: TIMEOUT })
  } catch (e) {
    // errors thrown inside the context are not host Error instances
    throw new Error(`${p.name}: ${(e as { message?: string })?.message ?? String(e)}`, { cause: e })
  }
  return out
}

// ---------- passcode lock (shared by all windows) ----------
let locked: boolean | undefined
const isLocked = (): boolean => (locked ??= !!getSetting('security.passcodeHash', ''))
function setLocked(v: boolean): void {
  locked = v
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('lock:changed', v)
}
let blurredAt = 0
app.on('browser-window-blur', () => { blurredAt = Date.now() })
app.on('browser-window-focus', () => {
  // switching between our own windows fires blur then focus at once, so only real time away counts
  const minutes = getSetting('security.autoLockMinutes', 0)
  if (blurredAt && minutes > 0 && getSetting('security.passcodeHash', '') && Date.now() - blurredAt > minutes * 60000) setLocked(true)
  blurredAt = 0
})

register({
  'plugin.list': () => list(),
  'plugin.install': (_c, folder: string) => install(folder),
  'plugin.reinstall': (_c, id: string) => reinstall(id),
  'plugin.remove': (_c, id: string) => { rmSync(findInstalled(id).path, { recursive: true, force: true }); return list() },
  'plugin.run': (c, id: string, commandId: string, data: PluginCtxData, sessionId?: string) => run(c.sender, id, commandId, data, sessionId),
  'plugin.confirmReply': (_c, token: string, ok: boolean) => void pending.get(token)?.(!!ok),
  'app.version': () => app.getVersion(),
  'app.dataPath': () => app.getPath('userData'),
  'lock.get': () => isLocked(),
  'lock.set': (_c, v: boolean) => setLocked(!!v),
  'lock.touchIdAvailable': () => process.platform === 'darwin' && systemPreferences.canPromptTouchID(),
  /** Main checks the fingerprint and unlocks itself, so the renderer cannot skip the check. */
  'lock.touchId': async () => {
    if (!isLocked() || !getSetting('security.touchId', false) || process.platform !== 'darwin' || !systemPreferences.canPromptTouchID()) return false
    try { await systemPreferences.promptTouchID('unlock your databases') } catch { return false }
    setLocked(false)
    return true
  }
})
