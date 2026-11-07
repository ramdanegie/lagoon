// Local app store: userData/app.db via node:sqlite. Only main touches it.
import { app, safeStorage } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'path'
import { mkdirSync } from 'fs'
import schema from './schema.sql?raw'
import type { Connection, Group, Tag, HistoryEntry } from '@shared/types'

let db: DatabaseSync

export function openStore(): void {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  db = new DatabaseSync(join(dir, 'app.db'))
  db.exec(schema)
  migrate()
}

/** Older stores limited history.source with a CHECK; new features log their own sources, so rebuild without it. */
function migrate(): void {
  const h = db.prepare("select sql from sqlite_master where type = 'table' and name = 'history'").get() as { sql: string } | undefined
  if (!h?.sql.includes('check (source in')) return
  db.exec(`begin;
    alter table history rename to history_old;
    ${schema.slice(schema.indexOf('create table if not exists history'), schema.indexOf(');', schema.indexOf('create table if not exists history')) + 2)}
    insert into history select * from history_old;
    drop table history_old;
    create index if not exists history_conn_time on history(connection_id, executed_at desc);
    commit;`)
}

const now = (): string => new Date().toISOString()
const j = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v))
const pj = <T>(v: unknown): T | undefined => (typeof v === 'string' && v ? (JSON.parse(v) as T) : undefined)

// ---------- secrets ----------
interface Secrets { password?: string; sshPassword?: string; sshPassphrase?: string }

function encrypt(s: Secrets): Uint8Array | null {
  if (!s.password && !s.sshPassword && !s.sshPassphrase) return null
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS secure storage is unavailable; passwords cannot be saved. Use "Ask every time".')
  return safeStorage.encryptString(JSON.stringify(s))
}

export function secretsOf(id: string): Secrets {
  const row = db.prepare('select secret from connections where id = ?').get(id) as { secret: Uint8Array | null } | undefined
  if (!row?.secret) return {}
  return JSON.parse(safeStorage.decryptString(Buffer.from(row.secret)))
}

// ---------- connections ----------
type Row = Record<string, unknown>

const toConn = (r: Row): Connection => ({
  id: r.id as string,
  name: r.name as string,
  driver: r.driver as Connection['driver'],
  host: (r.host as string) ?? undefined,
  port: (r.port as number) ?? undefined,
  username: (r.username as string) ?? undefined,
  database: (r.database as string) ?? undefined,
  filePath: (r.file_path as string) ?? undefined,
  passwordMode: r.password_mode as Connection['passwordMode'],
  passwordCommand: (r.password_command as string) ?? undefined,
  statusColor: (r.status_color as string) ?? undefined,
  tagId: (r.tag_id as string) ?? null,
  groupId: (r.group_id as string) ?? null,
  safeMode: r.safe_mode as number,
  bootstrapSql: (r.bootstrap_sql as string) ?? undefined,
  ssh: pj(r.ssh),
  ssl: pj(r.ssl),
  options: pj(r.options),
  sortOrder: r.sort_order as number
})

export const listConnections = (): Connection[] =>
  (db.prepare('select * from connections order by sort_order, name collate nocase').all() as Row[]).map(toConn)

export const getConnection = (id: string): Connection => {
  const r = db.prepare('select * from connections where id = ?').get(id) as Row | undefined
  if (!r) throw new Error('Connection not found')
  return toConn(r)
}

/** Insert or update. Secrets: undefined keeps the stored value, '' clears it. */
export function saveConnection(c: Connection): Connection {
  const exists = c.id && db.prepare('select 1 from connections where id = ?').get(c.id)
  const id = c.id || crypto.randomUUID()
  const old = exists ? secretsOf(id) : {}
  const pick = (v: string | undefined, o: string | undefined): string | undefined => (v === undefined ? o : v || undefined)
  const secret = encrypt(c.passwordMode === 'store' || c.ssh?.enabled
    ? { password: c.passwordMode === 'store' ? pick(c.password, old.password) : undefined, sshPassword: pick(c.sshPassword, old.sshPassword), sshPassphrase: pick(c.sshPassphrase, old.sshPassphrase) }
    : {})
  const vals = [c.name, c.driver, c.host ?? null, c.port ?? null, c.username ?? null, c.database ?? null, c.filePath ?? null,
    c.passwordMode, c.passwordCommand ?? null, secret, c.statusColor ?? null, c.tagId ?? null, c.groupId ?? null, c.safeMode ?? 0,
    c.bootstrapSql ?? null, j(c.ssh), j(c.ssl), j(c.options), c.sortOrder ?? 0]
  if (exists) {
    db.prepare(`update connections set name=?, driver=?, host=?, port=?, username=?, database=?, file_path=?, password_mode=?, password_command=?,
      secret=?, status_color=?, tag_id=?, group_id=?, safe_mode=?, bootstrap_sql=?, ssh=?, ssl=?, options=?, sort_order=?, updated_at=? where id=?`).run(...vals, now(), id)
  } else {
    db.prepare(`insert into connections (name, driver, host, port, username, database, file_path, password_mode, password_command,
      secret, status_color, tag_id, group_id, safe_mode, bootstrap_sql, ssh, ssl, options, sort_order, id) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...vals, id)
  }
  return getConnection(id)
}

export const deleteConnection = (id: string): void => void db.prepare('delete from connections where id = ?').run(id)

export function duplicateConnection(id: string): Connection {
  const c = getConnection(id)
  return saveConnection({ ...c, ...secretsOf(id), id: '', name: `${c.name} copy` })
}

export const patchConnection = (id: string, patch: Partial<Connection>): Connection => saveConnection({ ...getConnection(id), ...patch, id })

// ---------- tags & groups ----------
export const listTags = (): Tag[] =>
  (db.prepare('select * from tags order by builtin desc, name').all() as Row[]).map((r) => ({ id: r.id as string, name: r.name as string, color: r.color as string, builtin: !!r.builtin }))

export function saveTag(t: Partial<Tag> & { name: string; color: string }): Tag[] {
  if (t.id) db.prepare('update tags set name = case when builtin then name else ? end, color = ? where id = ?').run(t.name, t.color, t.id)
  else db.prepare('insert into tags (id, name, color) values (?,?,?)').run(crypto.randomUUID(), t.name, t.color)
  return listTags()
}
export const deleteTag = (id: string): Tag[] => (db.prepare('delete from tags where id = ? and builtin = 0').run(id), listTags())

export const listGroups = (): Group[] =>
  (db.prepare('select * from groups order by sort_order, name').all() as Row[]).map((r) => ({ id: r.id as string, name: r.name as string, icon: (r.icon as string) ?? undefined, parentId: (r.parent_id as string) ?? null, sortOrder: r.sort_order as number }))

export function saveGroup(g: Partial<Group> & { name: string }): Group[] {
  if (g.id) db.prepare('update groups set name=?, icon=?, parent_id=? where id=?').run(g.name, g.icon ?? null, g.parentId ?? null, g.id)
  else db.prepare('insert into groups (id, name, icon, parent_id) values (?,?,?,?)').run(crypto.randomUUID(), g.name, g.icon ?? null, g.parentId ?? null)
  return listGroups()
}
export const deleteGroup = (id: string): Group[] => (db.prepare('delete from groups where id = ?').run(id), listGroups())

// ---------- history ----------
export function addHistory(e: Omit<HistoryEntry, 'id' | 'executedAt'>): void {
  if (getSetting<boolean>('history.disabled', false)) return
  // history is a convenience: a failed write here must never fail the user's query
  try {
    db.prepare('insert into history (connection_id, database, sql, source, duration_ms, error) values (?,?,?,?,?,?)')
      .run(e.connectionId, e.database ?? null, e.sql, e.source, e.durationMs ?? null, e.error ?? null)
  } catch (err) {
    console.error('history write failed', err)
  }
}

export function listHistory(connectionId: string, search = '', limit = 500): HistoryEntry[] {
  const rows = db.prepare(`select * from history where connection_id = ? ${search ? 'and sql like ?' : ''} order by id desc limit ?`)
    .all(...(search ? [connectionId, `%${search}%`, limit] : [connectionId, limit])) as Row[]
  return rows.map((r) => ({ id: r.id as number, connectionId: r.connection_id as string, database: (r.database as string) ?? undefined, sql: r.sql as string, source: r.source as string, durationMs: (r.duration_ms as number) ?? undefined, error: (r.error as string) ?? undefined, executedAt: r.executed_at as string }))
}
export const deleteHistory = (id: number): void => void db.prepare('delete from history where id = ?').run(id)
export const clearHistory = (connectionId: string, before?: string): void =>
  void (before ? db.prepare('delete from history where connection_id = ? and executed_at < ?').run(connectionId, before) : db.prepare('delete from history where connection_id = ?').run(connectionId))
export function pruneHistory(): void {
  const years = getSetting<number>('history.retentionYears', 0)
  if (years > 0) db.prepare('delete from history where executed_at < ?').run(new Date(Date.now() - years * 365 * 864e5).toISOString())
}

// ---------- generic json state ----------
export function getState<T>(table: 'table_state' | 'diagram_layouts', connectionId: string, key: string): T | undefined {
  const col = table === 'table_state' ? ['object_key', 'state'] : ['schema_key', 'layout']
  const r = db.prepare(`select ${col[1]} v from ${table} where connection_id = ? and ${col[0]} = ?`).get(connectionId, key) as { v: string } | undefined
  return pj<T>(r?.v)
}
export function setState(table: 'table_state' | 'diagram_layouts', connectionId: string, key: string, value: unknown): void {
  const col = table === 'table_state' ? ['object_key', 'state'] : ['schema_key', 'layout']
  db.prepare(`insert into ${table} (connection_id, ${col[0]}, ${col[1]}) values (?,?,?) on conflict do update set ${col[1]} = excluded.${col[1]}`).run(connectionId, key, JSON.stringify(value))
}

export const getEditorTabs = (connectionId: string): { idx: number; title: string | null; content: string }[] =>
  db.prepare('select idx, title, content from editor_tabs where connection_id = ? order by idx').all(connectionId) as never
export function setEditorTabs(connectionId: string, tabs: { title?: string; content: string }[]): void {
  db.prepare('delete from editor_tabs where connection_id = ?').run(connectionId)
  const ins = db.prepare('insert into editor_tabs (connection_id, idx, title, content) values (?,?,?,?)')
  tabs.forEach((t, i) => ins.run(connectionId, i, t.title ?? null, t.content))
}

export const getQueryVars = (): Record<string, string> =>
  Object.fromEntries((db.prepare('select name, value from query_vars').all() as Row[]).map((r) => [r.name, r.value]))
export function setQueryVars(vars: Record<string, string>): void {
  const st = db.prepare('insert into query_vars (name, value, last_used_at) values (?,?,?) on conflict do update set value = excluded.value, last_used_at = excluded.last_used_at')
  for (const [k, v] of Object.entries(vars)) st.run(k, v, now())
}
export const deleteQueryVars = (names: string[]): void => names.forEach((n) => db.prepare('delete from query_vars where name = ?').run(n))

// ---------- metrics boards ----------
export interface BoardRow { id: string; name: string; connectionId: string | null; board: unknown }
export const listBoards = (): BoardRow[] =>
  (db.prepare('select * from metrics_boards order by name').all() as Row[]).map((r) => ({ id: r.id as string, name: r.name as string, connectionId: (r.connection_id as string) ?? null, board: pj(r.board) }))
export function saveBoard(b: Partial<BoardRow> & { name: string }): BoardRow[] {
  const id = b.id || crypto.randomUUID()
  db.prepare('insert into metrics_boards (id, name, connection_id, board, updated_at) values (?,?,?,?,?) on conflict do update set name=excluded.name, connection_id=excluded.connection_id, board=excluded.board, updated_at=excluded.updated_at')
    .run(id, b.name, b.connectionId ?? null, JSON.stringify(b.board ?? { objects: [], links: [] }), now())
  return listBoards()
}
export const deleteBoard = (id: string): BoardRow[] => (db.prepare('delete from metrics_boards where id = ?').run(id), listBoards())

// ---------- settings ----------
export function getSetting<T>(key: string, fallback: T): T {
  const r = db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined
  return r ? (JSON.parse(r.value) as T) : fallback
}
export const getAllSettings = (): Record<string, unknown> =>
  Object.fromEntries((db.prepare('select key, value from settings').all() as Row[]).map((r) => [r.key, JSON.parse(r.value as string)]))
export const setSetting = (key: string, value: unknown): void =>
  void db.prepare('insert into settings (key, value) values (?,?) on conflict do update set value = excluded.value').run(key, JSON.stringify(value))
