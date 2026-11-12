import { DatabaseSync } from 'node:sqlite'
import { readdirSync, existsSync } from 'fs'
import { basename, dirname, join } from 'path'
import type { Column, DbObject, ForeignKey, Index, Result, Trigger, DbUser, TableStat } from '@shared/types'
import { type ConnectParams, type SqlDriver, rowsOut } from './types'

const qi = (s: string): string => '"' + s.replace(/"/g, '""') + '"'

// shortcut: node:sqlite runs on the main thread and cannot be interrupted, so long SQLite queries block until done; move to a worker if that bites
export class SqliteDriver implements SqlDriver {
  dialect = 'sqlite' as const
  private db!: DatabaseSync
  private file: string
  onSql: (sql: string) => void = () => {}

  constructor(p: ConnectParams) {
    if (!p.filePath) throw new Error('Choose a database file.')
    this.file = p.filePath
  }

  async connect(): Promise<void> {
    if (this.file !== ':memory:' && !existsSync(dirname(this.file))) throw new Error(`Folder not found: ${dirname(this.file)}`)
    this.db = new DatabaseSync(this.file)
    this.db.exec('PRAGMA foreign_keys = ON')
  }

  close = async (): Promise<void> => { if (this.db?.isOpen) this.db.close() }
  ping = async (): Promise<void> => void this.db.prepare('select 1').get()
  serverVersion = async (): Promise<string> => (this.db.prepare('select sqlite_version() v').get() as { v: string }).v
  currentDatabase = (): string => basename(this.file)
  defaultSchema = (): string => 'main'

  private all<T>(sql: string, ...params: (string | number)[]): T[] {
    this.onSql(sql)
    return this.db.prepare(sql).all(...params) as T[]
  }

  /** Sibling .sqlite/.sqlite3/.db files in the same folder are the "databases" . */
  async databases(): Promise<string[]> {
    if (this.file === ':memory:') return [':memory:']
    return readdirSync(dirname(this.file)).filter((f) => /\.(sqlite3?|db)$/i.test(f)).sort()
  }

  async useDatabase(name: string): Promise<void> {
    await this.close()
    this.file = join(dirname(this.file), name)
    await this.connect()
  }

  async createDatabase(name: string): Promise<void> {
    const f = join(dirname(this.file), /\./.test(name) ? name : `${name}.sqlite3`)
    new DatabaseSync(f).close()
  }

  schemas = async (): Promise<string[]> => this.all<{ name: string }>('PRAGMA database_list').map((r) => r.name)

  async objects(schema: string): Promise<DbObject[]> {
    return this.all<{ name: string; type: string }>(`SELECT name, type FROM ${qi(schema)}.sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .map((r) => ({ schema, name: r.name, kind: r.type as DbObject['kind'] }))
  }

  async resolveTable(ref: { schema?: string; table: string }): Promise<{ schema: string; table: string } | null> {
    const schema = ref.schema ?? 'main'
    const [r] = this.all<{ name: string }>(`SELECT name FROM ${qi(schema)}.sqlite_master WHERE type IN ('table','view') AND name = ? COLLATE NOCASE`, ref.table)
    return r ? { schema, table: r.name } : null
  }

  async columns(schema: string, table: string): Promise<Column[]> {
    return this.all<Record<string, unknown>>(`PRAGMA ${qi(schema)}.table_xinfo(${qi(table)})`).map((r) => ({
      name: r.name as string, type: (r.type as string) || '', nullable: !r.notnull, default: (r.dflt_value as string) ?? null,
      pk: Number(r.pk) > 0, ordinal: Number(r.cid) + 1, extra: Number(r.hidden) > 0 ? 'generated' : null
    }))
  }

  async indexes(schema: string, table: string): Promise<Index[]> {
    return this.all<Record<string, unknown>>(`PRAGMA ${qi(schema)}.index_list(${qi(table)})`).map((r) => ({
      name: r.name as string, unique: !!r.unique, primary: r.origin === 'pk', condition: r.partial ? 'partial' : null,
      columns: this.all<{ name: string }>(`PRAGMA ${qi(schema)}.index_info(${qi(r.name as string)})`).map((c) => c.name)
    }))
  }

  async foreignKeys(schema: string, table: string): Promise<ForeignKey[]> {
    const rows = this.all<Record<string, unknown>>(`PRAGMA ${qi(schema)}.foreign_key_list(${qi(table)})`)
    const by = new Map<number, ForeignKey>()
    for (const r of rows) {
      const id = Number(r.id)
      const fk = by.get(id) ?? { name: `fk_${table}_${id}`, columns: [], refSchema: schema, refTable: r.table as string, refColumns: [], onUpdate: r.on_update as string, onDelete: r.on_delete as string }
      fk.columns.push(r.from as string)
      fk.refColumns.push((r.to as string) ?? '')
      by.set(id, fk)
    }
    return [...by.values()]
  }

  async triggers(schema: string, table: string): Promise<Trigger[]> {
    return this.all<{ name: string; sql: string }>(`SELECT name, sql FROM ${qi(schema)}.sqlite_master WHERE type = 'trigger' AND tbl_name = ?`, table).map((r) => {
      const m = /\b(BEFORE|AFTER|INSTEAD OF)?\s*(INSERT|UPDATE|DELETE)\b/i.exec(r.sql)
      return { name: r.name, timing: (m?.[1] ?? 'BEFORE').toUpperCase(), event: (m?.[2] ?? '').toUpperCase(), statement: r.sql }
    })
  }

  async ddl(schema: string, name: string): Promise<string> {
    const r = this.all<{ sql: string }>(`SELECT sql FROM ${qi(schema)}.sqlite_master WHERE name = ? OR (tbl_name = ? AND type = 'index' AND sql IS NOT NULL)`, name, name)
    return r.map((x) => x.sql + ';').join('\n\n')
  }

  estimateCount = async (): Promise<number | null> => null

  /** Exact row counts (a local file counts quickly); sizes from dbstat when SQLite was built with it. */
  async tableStats(schema: string): Promise<TableStat[]> {
    const sizes = new Map<string, { data: number; index: number }>()
    try {
      for (const r of this.all<{ t: string; type: string; size: number }>(`SELECT m.tbl_name AS t, m.type, SUM(s.pgsize) AS size FROM ${qi(schema)}.sqlite_master m JOIN dbstat('${schema.replace(/'/g, "''")}') s ON s.name = m.name GROUP BY m.tbl_name, m.type`)) {
        const e = sizes.get(r.t) ?? { data: 0, index: 0 }
        if (r.type === 'index') e.index += r.size; else e.data += r.size
        sizes.set(r.t, e)
      }
    } catch { /* no dbstat: sizes stay empty */ }
    return (await this.objects(schema)).map((o) => ({
      name: o.name, kind: o.kind, comment: null,
      rows: o.kind === 'table' ? Number(this.all<{ c: number }>(`SELECT count(*) AS c FROM ${qi(schema)}.${qi(o.name)}`)[0].c) : null,
      data: sizes.get(o.name)?.data ?? null, index: sizes.get(o.name)?.index ?? null
    }))
  }

  async query(sql: string): Promise<Result> {
    this.onSql(sql)
    const t = performance.now()
    const st = this.db.prepare(sql)
    const cols = st.columns()
    if (!cols.length) {
      const r = st.run()
      return { sql, columns: [], rows: [], rowCount: 0, affected: Number(r.changes), ms: Math.round(performance.now() - t) }
    }
    st.setReturnArrays(true)
    const rows = st.all() as unknown as unknown[][]
    return { sql, columns: cols.map((c) => ({ name: c.name, type: c.type ?? undefined, table: c.table ?? undefined })), rows: rowsOut(rows), rowCount: rows.length, affected: null, ms: Math.round(performance.now() - t) }
  }

  cancel = async (): Promise<void> => {}
  processes = async (): Promise<Result> => { throw new Error('SQLite has no process list.') }
  kill = async (): Promise<string> => { throw new Error('SQLite has no process list.') }
  users = async (): Promise<DbUser[]> => { throw new Error('SQLite has no users.') }
  userGrants = async (): Promise<{ scope: string; privileges: string[] }[]> => []
}
