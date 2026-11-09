import pg from 'pg'
import type { Column, DbObject, ForeignKey, Index, Result, Trigger, DbUser, TableStat } from '@shared/types'
import { type ConnectParams, type SqlDriver, rowsOut } from './types'

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

const FK_ACT: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' }
// Everything arrives as text so the grid shows exactly what the server sent; booleans become true/false.
const types = { getTypeParser: (oid: number) => (oid === 16 ? (v: string) => v === 't' : (v: string) => v) }

function sslOption(p: ConnectParams): pg.ClientConfig['ssl'] {
  const m = p.ssl?.mode ?? 'PREFERRED'
  if (m === 'DISABLED') return false
  const files = { ca: p.ssl?.ca, cert: p.ssl?.cert, key: p.ssl?.key }
  if (m === 'VERIFY-FULL') return { ...files, rejectUnauthorized: true }
  if (m === 'VERIFY-CA') return { ...files, rejectUnauthorized: true, checkServerIdentity: () => undefined }
  return { ...files, rejectUnauthorized: false }
}

export class PostgresDriver implements SqlDriver {
  dialect = 'postgres' as const
  private client!: pg.Client
  private db: string
  private notices: string[] = []
  private ssl: pg.ClientConfig['ssl']
  onSql: (sql: string) => void = () => {}

  constructor(private p: ConnectParams) {
    this.db = p.database || 'postgres'
    this.ssl = sslOption(p)
  }

  private config(database = this.db, ssl = this.ssl): pg.ClientConfig {
    return { host: this.p.host, port: this.p.port, user: this.p.user, password: this.p.password, database, ssl, types, application_name: 'Lagoon', connectionTimeoutMillis: 15000 }
  }

  async connect(): Promise<void> {
    try {
      this.client = new pg.Client(this.config())
      await this.client.connect()
    } catch (e) {
      // PREFERRED / ALLOW: fall back to plain TCP when the server refuses TLS
      const mode = this.p.ssl?.mode ?? 'PREFERRED'
      if ((mode === 'PREFERRED' || mode === 'ALLOW') && /does not support SSL/i.test(String(e))) {
        this.ssl = false
        this.client = new pg.Client(this.config())
        await this.client.connect()
      } else throw e
    }
    this.client.on('notice', (n) => this.notices.push(`${n.severity ?? 'NOTICE'}: ${n.message}`))
    this.client.on('error', () => {})
  }

  close = async (): Promise<void> => void (await this.client?.end().catch(() => {}))
  ping = async (): Promise<void> => void (await this.client.query('SELECT 1'))
  currentDatabase = (): string => this.db
  defaultSchema = (): string => 'public'

  async serverVersion(): Promise<string> {
    return (await this.client.query('SHOW server_version')).rows[0].server_version
  }

  private async rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.onSql(sql)
    return (await this.client.query(sql, params)).rows as T[]
  }

  async databases(): Promise<string[]> {
    return (await this.rows<{ datname: string }>('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1')).map((r) => r.datname)
  }

  async useDatabase(name: string): Promise<void> {
    const next = new pg.Client(this.config(name))
    await next.connect()
    await this.close()
    this.client = next
    this.db = name
    this.client.on('notice', (n) => this.notices.push(`${n.severity ?? 'NOTICE'}: ${n.message}`))
    this.client.on('error', () => {})
  }

  async createDatabase(name: string, encoding?: string, collation?: string): Promise<void> {
    const q = (s: string): string => '"' + s.replace(/"/g, '""') + '"'
    const lit = (s: string): string => "'" + s.replace(/'/g, "''") + "'"
    await this.query(`CREATE DATABASE ${q(name)}${encoding ? ` ENCODING ${lit(encoding)}` : ''}${collation ? ` LC_COLLATE ${lit(collation)} TEMPLATE template0` : ''}`)
  }

  async schemas(system = false): Promise<string[]> {
    const where = system ? '' : "WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'"
    return (await this.rows<{ nspname: string }>(`SELECT nspname FROM pg_namespace ${where} ORDER BY 1`)).map((r) => r.nspname)
  }

  async objects(schema: string): Promise<DbObject[]> {
    const rel = await this.rows<{ name: string; kind: string }>(
      `SELECT c.relname AS name, c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f','S') ORDER BY 1`, [schema])
    const fn = await this.rows<{ name: string; kind: string }>(
      `SELECT p.proname AS name, p.prokind AS kind FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.prokind IN ('f','p') ORDER BY 1`, [schema])
    const k: Record<string, DbObject['kind']> = { r: 'table', p: 'table', f: 'table', v: 'view', m: 'matview', S: 'sequence' }
    return [
      ...rel.map((r) => ({ schema, name: r.name, kind: k[r.kind] })),
      ...fn.map((r) => ({ schema, name: r.name, kind: (r.kind === 'p' ? 'procedure' : 'function') as DbObject['kind'] }))
    ]
  }

  async columns(schema: string, table: string): Promise<Column[]> {
    const r = await this.rows<Record<string, unknown>>(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
              pg_get_expr(d.adbin, d.adrelid) AS "default", a.attnum AS ordinal, col_description(c.oid, a.attnum) AS comment,
              COALESCE(a.attnum = ANY(i.indkey), false) AS pk,
              CASE WHEN a.attidentity <> '' THEN 'identity' WHEN a.attgenerated <> '' THEN 'generated' END AS extra
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
       WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [schema, table])
    return r.map((x) => ({ name: x.name as string, type: x.type as string, nullable: !!x.nullable, default: (x.default as string) ?? null, pk: !!x.pk, ordinal: Number(x.ordinal), comment: (x.comment as string) ?? null, extra: (x.extra as string) ?? null }))
  }

  async indexes(schema: string, table: string): Promise<Index[]> {
    const r = await this.rows<Record<string, unknown>>(
      `SELECT ic.relname AS name, i.indisunique AS unique, i.indisprimary AS primary, am.amname AS type,
              pg_get_expr(i.indpred, i.indrelid) AS condition,
              ARRAY(SELECT pg_get_indexdef(i.indexrelid, k + 1, true) FROM generate_subscripts(i.indkey, 1) k ORDER BY k) AS columns
       FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_am am ON am.oid = ic.relam
       WHERE n.nspname = $1 AND c.relname = $2 ORDER BY i.indisprimary DESC, 1`, [schema, table])
    return r.map((x) => ({ name: x.name as string, unique: !!x.unique, primary: !!x.primary, type: x.type as string, condition: (x.condition as string) ?? null, columns: parseArr(x.columns) }))
  }

  async foreignKeys(schema: string, table: string): Promise<ForeignKey[]> {
    const r = await this.rows<Record<string, unknown>>(
      `SELECT con.conname AS name, rn.nspname AS ref_schema, rc.relname AS ref_table, con.confupdtype AS upd, con.confdeltype AS del,
              ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o) AS columns,
              ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.o) AS ref_columns
       FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class rc ON rc.oid = con.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
       WHERE con.contype = 'f' AND n.nspname = $1 AND c.relname = $2 ORDER BY 1`, [schema, table])
    return r.map((x) => ({ name: x.name as string, columns: parseArr(x.columns), refSchema: x.ref_schema as string, refTable: x.ref_table as string, refColumns: parseArr(x.ref_columns), onUpdate: FK_ACT[x.upd as string], onDelete: FK_ACT[x.del as string] }))
  }

  async triggers(schema: string, table: string): Promise<Trigger[]> {
    const r = await this.rows<Record<string, unknown>>(
      `SELECT t.tgname AS name, pg_get_triggerdef(t.oid, true) AS statement,
              CASE WHEN t.tgtype & 2 = 2 THEN 'BEFORE' WHEN t.tgtype & 64 = 64 THEN 'INSTEAD OF' ELSE 'AFTER' END AS timing,
              concat_ws(' OR ', CASE WHEN t.tgtype & 4 = 4 THEN 'INSERT' END, CASE WHEN t.tgtype & 8 = 8 THEN 'DELETE' END,
                        CASE WHEN t.tgtype & 16 = 16 THEN 'UPDATE' END, CASE WHEN t.tgtype & 32 = 32 THEN 'TRUNCATE' END) AS event
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE NOT t.tgisinternal AND n.nspname = $1 AND c.relname = $2 ORDER BY 1`, [schema, table])
    return r as unknown as Trigger[]
  }

  async ddl(schema: string, name: string, kind: string): Promise<string> {
    if (kind === 'view' || kind === 'matview') {
      const [r] = await this.rows<{ def: string }>(`SELECT pg_get_viewdef(format('%I.%I', $1::text, $2::text)::regclass, true) AS def`, [schema, name])
      return `CREATE ${kind === 'matview' ? 'MATERIALIZED VIEW' : 'OR REPLACE VIEW'} "${schema}"."${name}" AS\n${r.def}`
    }
    if (kind === 'function' || kind === 'procedure') {
      const r = await this.rows<{ def: string }>(`SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2`, [schema, name])
      return r.map((x) => x.def).join(';\n\n')
    }
    if (kind === 'sequence') return `CREATE SEQUENCE "${schema}"."${name}";`
    const cols = await this.columns(schema, name)
    const cons = await this.rows<{ name: string; def: string }>(
      `SELECT conname AS name, pg_get_constraintdef(con.oid, true) AS def FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 ORDER BY contype = 'p' DESC, 1`, [schema, name])
    const idx = await this.rows<{ def: string }>(
      `SELECT pg_get_indexdef(i.indexrelid) AS def FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2 AND NOT i.indisprimary AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)`, [schema, name])
    const lines = [
      ...cols.map((c) => `  "${c.name}" ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.default ? ` DEFAULT ${c.default}` : ''}`),
      ...cons.map((c) => `  CONSTRAINT "${c.name}" ${c.def}`)
    ]
    return [`CREATE TABLE "${schema}"."${name}" (\n${lines.join(',\n')}\n);`, ...idx.map((i) => i.def + ';')].join('\n\n')
  }

  async estimateCount(schema: string, table: string): Promise<number | null> {
    const [r] = await this.rows<{ n: string }>(`SELECT c.reltuples::bigint AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`, [schema, table])
    return r && Number(r.n) >= 0 ? Number(r.n) : null
  }

  async tableStats(schema: string): Promise<TableStat[]> {
    const r = await this.rows<{ name: string; kind: string; n: string | null; data: string | null; idx: string | null; comment: string | null }>(
      `SELECT c.relname AS name, CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' ELSE 'table' END AS kind,
         CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint END AS n,
         CASE WHEN c.relkind <> 'v' THEN pg_table_size(c.oid) END AS data,
         CASE WHEN c.relkind <> 'v' THEN pg_indexes_size(c.oid) END AS idx,
         obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition
       ORDER BY c.relname`, [schema])
    return r.map((x) => ({ name: x.name, kind: x.kind as TableStat['kind'], rows: n(x.n), data: n(x.data), index: n(x.idx), comment: x.comment }))
  }

  async query(sql: string): Promise<Result> {
    this.notices = []
    this.onSql(sql)
    const t = performance.now()
    const r = (await this.client.query({ text: sql, rowMode: 'array' })) as unknown as pg.QueryArrayResult | pg.QueryArrayResult[]
    const last = Array.isArray(r) ? r[r.length - 1] : r
    const fields = last.fields ?? []
    return {
      sql,
      columns: fields.map((f) => ({ name: f.name, type: String(f.dataTypeID), table: f.tableID ? String(f.tableID) : undefined })),
      rows: rowsOut((last.rows ?? []) as unknown[][]),
      rowCount: last.rows?.length ?? 0,
      affected: fields.length ? null : last.rowCount,
      command: last.command,
      notices: [...this.notices],
      ms: Math.round(performance.now() - t)
    }
  }

  async cancel(): Promise<void> {
    const pid = (this.client as unknown as { processID: number }).processID
    const side = new pg.Client(this.config())
    await side.connect()
    try { await side.query('SELECT pg_cancel_backend($1)', [pid]) } finally { await side.end() }
  }

  processes = (): Promise<Result> =>
    this.query(`SELECT pid, datname, usename, application_name, client_addr, query_start, state, query FROM pg_stat_activity WHERE state IS DISTINCT FROM 'idle' AND pid <> pg_backend_pid() ORDER BY query_start DESC NULLS LAST`)

  async kill(id: string): Promise<string> {
    const sql = `SELECT pg_cancel_backend(${Number(id)});`
    await this.query(sql)
    return sql
  }

  async users(): Promise<DbUser[]> {
    const r = await this.rows<Record<string, unknown>>(`SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY 1`)
    return r.map((x) => ({ name: x.rolname as string, superuser: !!x.rolsuper, canCreateDb: !!x.rolcreatedb, canCreateRole: !!x.rolcreaterole, replication: !!x.rolreplication, bypassRls: !!x.rolbypassrls, canLogin: !!x.rolcanlogin }))
  }

  async userGrants(name: string): Promise<{ scope: string; privileges: string[] }[]> {
    const r = await this.rows<{ scope: string; privs: string }>(
      `SELECT table_schema || '.' || table_name AS scope, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
       FROM information_schema.role_table_grants WHERE grantee = $1 GROUP BY 1 ORDER BY 1`, [name])
    return r.map((x) => ({ scope: x.scope, privileges: x.privs.split(',') }))
  }
}

/** pg returns arrays as JS arrays or as '{a,b}' text (our text parser); handle both. */
function parseArr(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[]
  if (typeof v !== 'string') return []
  return v.replace(/^\{|\}$/g, '').split(',').filter(Boolean).map((s) => s.replace(/^"|"$/g, ''))
}
