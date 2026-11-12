// One IPC channel: renderer calls window.api.call(method, ...args) → registry[method](ctx, ...args).
import { ipcMain, dialog, shell, BrowserWindow, type WebContents } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import type { Connection, Result, TableQuery } from '@shared/types'
import { dialectOf } from '@shared/types'
import { selectSql, countSql } from '@shared/sqlgen'
import * as store from './store'
import { openSession, closeSession, reconnect, session, sqlDriver, buildDriver, checkPassword } from './sessions'
import type { RedisDriver } from './drivers/redis'
import type { MongoDriver } from './drivers/mongo'

export interface Ctx { sender: WebContents; win: BrowserWindow | null }
type Fn = (ctx: Ctx, ...args: never[]) => unknown
const methods: Record<string, Fn> = {}

export const register = (defs: Record<string, Fn>): void => void Object.assign(methods, defs)

export function startRpc(): void {
  ipcMain.handle('rpc', async (e, method: string, args: unknown[]) => {
    const fn = methods[method]
    if (!fn) throw new Error(`Unknown method ${method}`)
    try {
      return await fn({ sender: e.sender, win: BrowserWindow.fromWebContents(e.sender) }, ...(args as never[]))
    } catch (err) {
      // keep the driver's message; Electron prefixes it otherwise
      throw new Error(err instanceof Error ? err.message : String(err))
    }
  })
}

const redis = (id: string): RedisDriver => session(id).driver as RedisDriver
const mongo = (id: string): MongoDriver => session(id).driver as MongoDriver

async function runLogged(sessionId: string, sql: string, source: string): Promise<Result> {
  const s = session(sessionId)
  const d = sqlDriver(sessionId)
  const t = Date.now()
  try {
    const r = await d.query(sql)
    store.addHistory({ connectionId: s.conn.id, database: d.currentDatabase(), sql, source, durationMs: Date.now() - t })
    return r
  } catch (e) {
    store.addHistory({ connectionId: s.conn.id, database: d.currentDatabase(), sql, source, durationMs: Date.now() - t, error: String((e as Error).message) })
    throw e
  }
}

register({
  // ---- saved connections ----
  'conn.list': () => store.listConnections(),
  'conn.get': (_c, id: string) => store.getConnection(id),
  'conn.save': (_c, c: Connection) => store.saveConnection(c),
  'conn.patch': (_c, id: string, patch: Partial<Connection>) => store.patchConnection(id, patch),
  'conn.delete': (_c, id: string) => store.deleteConnection(id),
  'conn.duplicate': (_c, id: string) => store.duplicateConnection(id),
  'conn.hasSecret': (_c, id: string) => { const s = store.secretsOf(id); return { password: !!s.password, sshPassword: !!s.sshPassword } },
  /** Test with the unsaved form values; blank secrets fall back to the stored ones. */
  'conn.test': async (_c, c: Connection) => {
    const stored = c.id ? store.secretsOf(c.id) : {}
    const { driver, tunnel } = await buildDriver(c, { password: c.password || stored.password, sshPassword: c.sshPassword || stored.sshPassword, sshPassphrase: c.sshPassphrase || stored.sshPassphrase })
    const v = await driver.serverVersion()
    await driver.close()
    tunnel?.server.close()
    tunnel?.ssh.end()
    return v
  },
  'tag.list': () => store.listTags(),
  'tag.save': (_c, t) => store.saveTag(t),
  'tag.delete': (_c, id: string) => store.deleteTag(id),
  'group.list': () => store.listGroups(),
  'group.save': (_c, g) => store.saveGroup(g),
  'group.delete': (_c, id: string) => store.deleteGroup(id),

  // ---- sessions ----
  'session.open': (c, id: string, asked?: { password?: string; sshPassword?: string }, override?: { database?: string }) => openSession(id, c.sender, asked, override),
  'session.close': (_c, id: string) => closeSession(id),
  'session.reconnect': (_c, id: string) => reconnect(id),
  'session.checkPassword': (_c, id: string, pw: string) => checkPassword(id, pw),

  // ---- SQL ----
  'db.databases': (_c, s: string) => sqlDriver(s).databases(),
  'db.use': async (_c, s: string, name: string) => { await sqlDriver(s).useDatabase(name); return { database: name, schema: sqlDriver(s).defaultSchema() } },
  'db.create': (_c, s: string, name: string, enc?: string, coll?: string) => sqlDriver(s).createDatabase(name, enc, coll),
  'db.schemas': (_c, s: string, system?: boolean) => sqlDriver(s).schemas(system),
  'db.objects': (_c, s: string, schema: string) => sqlDriver(s).objects(schema),
  'db.columns': (_c, s: string, schema: string, table: string) => sqlDriver(s).columns(schema, table),
  'db.indexes': (_c, s: string, schema: string, table: string) => sqlDriver(s).indexes(schema, table),
  'db.fks': (_c, s: string, schema: string, table: string) => sqlDriver(s).foreignKeys(schema, table),
  'db.triggers': (_c, s: string, schema: string, table: string) => sqlDriver(s).triggers(schema, table),
  'db.ddl': (_c, s: string, schema: string, name: string, kind: string) => sqlDriver(s).ddl(schema, name, kind),
  'db.estimate': (_c, s: string, schema: string, table: string) => sqlDriver(s).estimateCount(schema, table),
  'db.tableStats': (_c, s: string, schema: string) => sqlDriver(s).tableStats(schema),
  'db.rows': async (_c, s: string, q: TableQuery, cols: { name: string; type: string }[]) => {
    const d = sqlDriver(s)
    const sql = selectSql(d.dialect, q, cols)
    return { ...(await d.query(sql)), sql }
  },
  'db.count': async (_c, s: string, q: TableQuery, cols: { name: string; type: string }[]) => {
    const d = sqlDriver(s)
    const r = await d.query(countSql(d.dialect, q, cols))
    return Number(r.rows[0]?.[0] ?? 0)
  },
  /** table -> column names for the whole schema, in one round trip (editor autocomplete). */
  'db.schemaColumns': async (_c, s: string, schema: string) => {
    const d = sqlDriver(s)
    const out: Record<string, string[]> = {}
    if (d.dialect === 'sqlite') {
      for (const o of await d.objects(schema)) out[o.name] = (await d.columns(schema, o.name)).map((c) => c.name)
      return out
    }
    const r = await d.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = '${schema.replace(/'/g, "''")}' ORDER BY table_name, ordinal_position`)
    for (const [t, c] of r.rows as [string, string][]) (out[t] ??= []).push(c)
    return out
  },
  /** Run statements one by one; each gets its own Result (error included) unless stopOnError. */
  'db.query': async (_c, s: string, stmts: string[], opts: { stopOnError?: boolean; source?: string } = {}) => {
    const out: Result[] = []
    for (const sql of stmts) {
      try {
        out.push(await runLogged(s, sql, opts.source ?? 'editor'))
      } catch (e) {
        out.push({ sql, columns: [], rows: [], rowCount: 0, ms: 0, error: (e as Error).message })
        if (opts.stopOnError) break
      }
    }
    return out
  },
  'db.cancel': (_c, s: string) => sqlDriver(s).cancel(),
  /** Pending GUI changes: all-or-nothing. MySQL DDL commits implicitly, which the UI warns about. */
  'db.commit': async (_c, s: string, stmts: string[]) => {
    const d = sqlDriver(s)
    const begin = d.dialect === 'mysql' ? 'START TRANSACTION' : 'BEGIN'
    await d.query(begin)
    for (let i = 0; i < stmts.length; i++) {
      try {
        await runLogged(s, stmts[i], 'commit')
      } catch (e) {
        await d.query('ROLLBACK').catch(() => {})
        return { ok: false, index: i, error: (e as Error).message }
      }
    }
    await d.query('COMMIT')
    return { ok: true }
  },
  'db.processes': (_c, s: string) => sqlDriver(s).processes(),
  'db.kill': (_c, s: string, id: string) => sqlDriver(s).kill(id),
  'db.users': (_c, s: string) => sqlDriver(s).users(),
  'db.userGrants': (_c, s: string, name: string, host?: string) => sqlDriver(s).userGrants(name, host),
  'db.dialect': (_c, s: string) => dialectOf(session(s).conn.driver),

  // ---- Redis ----
  'redis.databases': (_c, s: string) => redis(s).databases(),
  'redis.select': (_c, s: string, i: number) => redis(s).select(i),
  'redis.scan': (_c, s: string, pattern: string, cursor?: string, count?: number) => redis(s).scan(pattern, cursor, count),
  'redis.get': (_c, s: string, key: string) => redis(s).get(key),
  'redis.write': (_c, s: string, args: (string | number)[]) => redis(s).write(args),
  'redis.command': (_c, s: string, line: string) => redis(s).command(line),

  // ---- MongoDB ----
  'mongo.databases': (_c, s: string) => mongo(s).databases(),
  'mongo.use': (_c, s: string, db: string) => mongo(s).use(db),
  'mongo.collections': (_c, s: string) => mongo(s).collections(),
  'mongo.find': (_c, s: string, coll: string, filter?: string, sort?: string, skip?: number, limit?: number) => mongo(s).find(coll, filter, sort, skip, limit),
  'mongo.insert': (_c, s: string, coll: string, doc: string) => mongo(s).insert(coll, doc),
  'mongo.update': (_c, s: string, coll: string, id: string, set: string, unset?: string[]) => mongo(s).update(coll, id, set, unset),
  'mongo.replace': (_c, s: string, coll: string, id: string, doc: string) => mongo(s).replace(coll, id, doc),
  'mongo.remove': (_c, s: string, coll: string, ids: string[]) => mongo(s).remove(coll, ids),
  'mongo.createCollection': (_c, s: string, name: string) => mongo(s).createCollection(name),
  'mongo.dropCollection': (_c, s: string, name: string) => mongo(s).dropCollection(name),
  'mongo.truncateCollection': (_c, s: string, name: string) => mongo(s).truncateCollection(name),
  'mongo.indexes': (_c, s: string, coll: string) => mongo(s).indexes(coll),
  'mongo.command': (_c, s: string, json: string) => mongo(s).command(json),
  'mongo.shell': (_c, s: string, code: string) => mongo(s).shell(code),
  'mongo.aggregate': (_c, s: string, coll: string, pipeline: string, limit?: number) => mongo(s).aggregate(coll, pipeline, limit),

  // ---- history & state ----
  'history.list': (_c, connId: string, search?: string) => store.listHistory(connId, search),
  'history.delete': (_c, id: number) => store.deleteHistory(id),
  'history.clear': (_c, connId: string, before?: string) => store.clearHistory(connId, before),
  'tableState.get': (_c, connId: string, key: string) => store.getState('table_state', connId, key),
  'tableState.set': (_c, connId: string, key: string, v: unknown) => store.setState('table_state', connId, key, v),
  'diagram.get': (_c, connId: string, key: string) => store.getState('diagram_layouts', connId, key),
  'diagram.set': (_c, connId: string, key: string, v: unknown) => store.setState('diagram_layouts', connId, key, v),
  'editorTabs.get': (_c, connId: string) => store.getEditorTabs(connId),
  'editorTabs.set': (_c, connId: string, tabs: { title?: string; content: string }[]) => store.setEditorTabs(connId, tabs),
  'vars.get': () => store.getQueryVars(),
  'vars.set': (_c, v: Record<string, string>) => store.setQueryVars(v),
  'vars.delete': (_c, names: string[]) => store.deleteQueryVars(names),
  'settings.all': () => store.getAllSettings(),
  'settings.set': (_c, key: string, value: unknown) => {
    store.setSetting(key, value)
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings:changed', key, value)
  },
  'metrics.list': () => store.listBoards(),
  'metrics.save': (_c, b) => store.saveBoard(b),
  'metrics.delete': (_c, id: string) => store.deleteBoard(id),

  // ---- native ----
  'dialog.open': async (c, opts: Electron.OpenDialogOptions) => (await dialog.showOpenDialog(c.win!, opts)).filePaths,
  'dialog.save': async (c, opts: Electron.SaveDialogOptions) => (await dialog.showSaveDialog(c.win!, opts)).filePath,
  'file.read': (_c, path: string) => readFileSync(path, 'utf8'),
  'file.readBase64': (_c, path: string) => readFileSync(path).toString('base64'),
  'file.write': (_c, path: string, data: string) => writeFileSync(path, data),
  'file.writeBase64': (_c, path: string, b64: string) => writeFileSync(path, Buffer.from(b64, 'base64')),
  'shell.reveal': (_c, path: string) => shell.showItemInFolder(path),
  'shell.open': (_c, url: string) => /^https?:\/\//.test(url) && shell.openExternal(url),
  'app.platform': () => process.platform
})
