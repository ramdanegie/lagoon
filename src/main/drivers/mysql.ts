import mysql from 'mysql2/promise'
import type { Column, DbObject, ForeignKey, Index, Result, Trigger, DbUser, TableStat } from '@shared/types'
import { type ConnectParams, type SqlDriver, rowsOut } from './types'

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

function sslOption(p: ConnectParams): mysql.ConnectionOptions['ssl'] {
  const m = p.ssl?.mode ?? 'PREFERRED'
  if (m === 'DISABLED' || m === 'PREFERRED') return undefined // shortcut: PREFERRED connects without TLS; mysql2 has no opportunistic TLS, use REQUIRED to force it
  const files = { ca: p.ssl?.ca, cert: p.ssl?.cert, key: p.ssl?.key }
  if (m === 'VERIFY-IDENTITY') return { ...files, rejectUnauthorized: true }
  if (m === 'VERIFY-CA') return { ...files, rejectUnauthorized: true, checkServerIdentity: () => undefined } as never
  return { ...files, rejectUnauthorized: false }
}

const qi = (s: string): string => '`' + s.replace(/`/g, '``') + '`'

export class MysqlDriver implements SqlDriver {
  dialect = 'mysql' as const
  private c!: mysql.Connection
  private db?: string
  onSql: (sql: string) => void = () => {}

  constructor(private p: ConnectParams) { this.db = p.database || undefined }

  private opts(): mysql.ConnectionOptions {
    return {
      host: this.p.host, port: this.p.port, user: this.p.user, password: this.p.password, database: this.db,
      ssl: sslOption(this.p), dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, connectTimeout: 15000,
      // BIT(1) → 0/1 instead of a Buffer; DOUBLE/FLOAT as the server's text so values aren't altered on the way
      typeCast: (field, next) => (field.type === 'BIT' && field.length === 1 ? (field.buffer()?.[0] ?? null) : field.type === 'DOUBLE' || field.type === 'FLOAT' ? field.string() : next())
    }
  }

  async connect(): Promise<void> {
    this.c = await mysql.createConnection(this.opts())
    this.c.on('error', () => {})
  }

  close = async (): Promise<void> => void (await this.c?.end().catch(() => {}))
  ping = async (): Promise<void> => void (await this.c.ping())
  currentDatabase = (): string | undefined => this.db
  defaultSchema = (): string => this.db ?? ''

  private async rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.onSql(sql)
    const [r] = await this.c.query(sql, params)
    return r as T[]
  }

  async serverVersion(): Promise<string> {
    return (await this.rows<{ v: string }>('SELECT VERSION() AS v'))[0].v
  }

  async databases(): Promise<string[]> {
    return (await this.rows<{ Database: string }>('SHOW DATABASES')).map((r) => r.Database)
  }

  async useDatabase(name: string): Promise<void> {
    await this.rows(`USE ${qi(name)}`)
    this.db = name
  }

  async createDatabase(name: string, encoding?: string, collation?: string): Promise<void> {
    await this.query(`CREATE DATABASE ${qi(name)}${encoding ? ` CHARACTER SET ${encoding}` : ''}${collation ? ` COLLATE ${collation}` : ''}`)
  }

  // MySQL "schema" == database: the sidebar shows the current database's objects.
  async schemas(): Promise<string[]> { return this.db ? [this.db] : [] }

  async objects(schema: string): Promise<DbObject[]> {
    const t = await this.rows<{ name: string; type: string }>(`SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY 1`, [schema])
    const r = await this.rows<{ name: string; type: string }>(`SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY 1`, [schema])
    return [
      ...t.map((x) => ({ schema, name: x.name, kind: (x.type === 'VIEW' ? 'view' : 'table') as DbObject['kind'] })),
      ...r.map((x) => ({ schema, name: x.name, kind: (x.type === 'PROCEDURE' ? 'procedure' : 'function') as DbObject['kind'] }))
    ]
  }

  async resolveTable(ref: { schema?: string; table: string }): Promise<{ schema: string; table: string } | null> {
    const [r] = await this.rows<{ s: string; t: string }>('SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? LIMIT 1', [ref.schema ?? null, ref.table])
    return r ? { schema: r.s, table: r.t } : null
  }

  async columns(schema: string, table: string): Promise<Column[]> {
    const r = await this.rows<Record<string, unknown>>(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE = 'YES' AS nullable, COLUMN_DEFAULT AS dflt,
              COLUMN_KEY = 'PRI' AS pk, ORDINAL_POSITION AS ordinal, COLUMN_COMMENT AS comment, EXTRA AS extra
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [schema, table])
    return r.map((x) => ({ name: x.name as string, type: x.type as string, nullable: !!Number(x.nullable), default: (x.dflt as string) ?? null, pk: !!Number(x.pk), ordinal: Number(x.ordinal), comment: (x.comment as string) || null, extra: (x.extra as string) || null }))
  }

  async indexes(schema: string, table: string): Promise<Index[]> {
    const r = await this.rows<Record<string, unknown>>(
      `SELECT INDEX_NAME AS name, NON_UNIQUE AS nu, INDEX_TYPE AS type, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? GROUP BY INDEX_NAME, NON_UNIQUE, INDEX_TYPE ORDER BY INDEX_NAME = 'PRIMARY' DESC, 1`, [schema, table])
    return r.map((x) => ({ name: x.name as string, unique: !Number(x.nu), primary: x.name === 'PRIMARY', type: x.type as string, columns: String(x.cols ?? '').split(',') }))
  }

  async foreignKeys(schema: string, table: string): Promise<ForeignKey[]> {
    const r = await this.rows<Record<string, unknown>>(
      `SELECT k.CONSTRAINT_NAME AS name, GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION) AS cols, k.REFERENCED_TABLE_SCHEMA AS rs,
              k.REFERENCED_TABLE_NAME AS rt, GROUP_CONCAT(k.REFERENCED_COLUMN_NAME ORDER BY k.ORDINAL_POSITION) AS rcols, rc.UPDATE_RULE AS upd, rc.DELETE_RULE AS del
       FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = k.CONSTRAINT_NAME
       WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
       GROUP BY k.CONSTRAINT_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, rc.UPDATE_RULE, rc.DELETE_RULE`, [schema, table])
    return r.map((x) => ({ name: x.name as string, columns: String(x.cols).split(','), refSchema: x.rs as string, refTable: x.rt as string, refColumns: String(x.rcols).split(','), onUpdate: x.upd as string, onDelete: x.del as string }))
  }

  async triggers(schema: string, table: string): Promise<Trigger[]> {
    return this.rows<Trigger>(`SELECT TRIGGER_NAME AS name, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event, ACTION_STATEMENT AS statement FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?`, [schema, table])
  }

  async ddl(schema: string, name: string, kind: string): Promise<string> {
    const what = kind === 'view' ? 'VIEW' : kind === 'function' ? 'FUNCTION' : kind === 'procedure' ? 'PROCEDURE' : 'TABLE'
    const [r] = await this.rows<Record<string, string>>(`SHOW CREATE ${what} ${qi(schema)}.${qi(name)}`)
    return (r['Create Table'] ?? r['Create View'] ?? r['Create Function'] ?? r['Create Procedure'] ?? '') + ';'
  }

  async estimateCount(schema: string, table: string): Promise<number | null> {
    const [r] = await this.rows<{ n: string | null }>(`SELECT TABLE_ROWS AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, [schema, table])
    return r?.n == null ? null : Number(r.n)
  }

  async tableStats(schema: string): Promise<TableStat[]> {
    // TABLE_ROWS is exact for MyISAM and an estimate for InnoDB
    const r = await this.rows<{ name: string; type: string; n: string | null; data: string | null; idx: string | null; comment: string | null }>(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS n, DATA_LENGTH AS data, INDEX_LENGTH AS idx, TABLE_COMMENT AS comment
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [schema])
    return r.map((x) => {
      const view = x.type === 'VIEW'
      return { name: x.name, kind: view ? 'view' : 'table', rows: view ? null : n(x.n), data: view ? null : n(x.data), index: view ? null : n(x.idx), comment: view || !x.comment ? null : x.comment }
    })
  }

  async query(sql: string): Promise<Result> {
    this.onSql(sql)
    const t = performance.now()
    const [rows, fields] = await this.c.query({ sql, rowsAsArray: true })
    const ms = Math.round(performance.now() - t)
    if (!Array.isArray(rows)) {
      const h = rows as mysql.ResultSetHeader
      return { sql, columns: [], rows: [], rowCount: 0, affected: h.affectedRows, notices: h.info ? [h.info] : [], ms }
    }
    const f = (fields ?? []) as mysql.FieldPacket[]
    if (/^\s*use\s+/i.test(sql)) this.db = sql.trim().replace(/^use\s+/i, '').replace(/[`;]/g, '').trim()
    return { sql, columns: f.map((x) => ({ name: x.name, type: String(x.type), table: x.orgTable || undefined })), rows: rowsOut(rows as unknown[][]), rowCount: rows.length, affected: null, ms }
  }

  async cancel(): Promise<void> {
    const side = await mysql.createConnection(this.opts())
    try { await side.query(`KILL QUERY ${this.c.threadId}`) } finally { await side.end() }
  }

  processes = (): Promise<Result> =>
    this.query(`SELECT ID, USER, HOST, DB, COMMAND, TIME, STATE, INFO FROM information_schema.PROCESSLIST WHERE ID <> CONNECTION_ID() ORDER BY TIME DESC`)

  async kill(id: string): Promise<string> {
    const sql = `KILL QUERY ${Number(id)};`
    await this.query(sql)
    return sql
  }

  async users(): Promise<DbUser[]> {
    const r = await this.rows<Record<string, unknown>>(`SELECT User AS name, Host AS host, max_questions, max_updates, max_connections FROM mysql.user ORDER BY 1, 2`)
    return r.map((x) => ({ name: x.name as string, host: x.host as string, maxQueries: Number(x.max_questions), maxUpdates: Number(x.max_updates), maxConnections: Number(x.max_connections) }))
  }

  async userGrants(name: string, host = '%'): Promise<{ scope: string; privileges: string[] }[]> {
    const r = await this.rows<Record<string, string>>(`SHOW GRANTS FOR ?@?`, [name, host])
    return r.map((x) => Object.values(x)[0]).map((g) => {
      const m = /^GRANT (.+) ON (.+) TO /i.exec(g)
      return { scope: m?.[2] ?? '', privileges: (m?.[1] ?? '').split(',').map((s) => s.trim()) }
    })
  }
}
