// Structure synchronization: a private session per side, and catalog readers that build the shared schema model.
// Comparing, ordering and script generation live in @shared/structsync.
import { qi, lit } from '@shared/sqlgen'
import { parseMysqlCreateTable, type SchemaModel, type STable, type SConstraint, type ConsKind, type SRoutine } from '@shared/structsync'
import { register } from './rpc'
import { openSession, closeSession, session, sqlDriver } from './sessions'
import type { SqlDriver } from './drivers/types'
import { pgOpt, PG_PROKIND } from './drivers/postgres'

type Row = Record<string, unknown>
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const json = <T>(v: unknown): T[] => (v ? (JSON.parse(String(v)) as T[] | null) ?? [] : [])
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function rows(d: SqlDriver, sql: string): Promise<Row[]> {
  const r = await d.query(sql)
  return r.rows.map((x) => Object.fromEntries(r.columns.map((c, i) => [c.name, x[i]])))
}

function tableMap(list: Row[]): Map<string, STable> {
  return new Map(list.map((r) => [String(r.name), { name: String(r.name), columns: [], constraints: [], indexes: [], comment: str(r.comment) || null, collation: str(r.coll), options: null }]))
}

const PG_KIND: Record<string, ConsKind> = { p: 'pk', u: 'unique', c: 'check', x: 'exclude', f: 'fk' }

/** Reads one schema. Runs on a private session: search_path is set to the schema so own objects come back unqualified. */
export async function readPostgres(d: SqlDriver, schema: string): Promise<SchemaModel> {
  const [[ver]] = (await d.query("SELECT current_setting('server_version_num')::int")).rows as [[number]]
  if (ver < 100000) throw new Error('Structure sync needs PostgreSQL 10 or newer')
  const S = lit('postgres', schema)
  await d.query(`SET search_path TO ${qi('postgres', schema)}`)
  const noExt = (oid: string): string => `NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.objid = ${oid} AND e.deptype = 'e')`
  const rel = `n.nspname = ${S} AND c.relkind IN ('r','p') AND NOT c.relispartition`
  const [qs] = (await d.query(`SELECT quote_ident(${S})`)).rows[0] as [string]
  const tables = tableMap(await rows(d, `SELECT c.relname AS name, obj_description(c.oid, 'pg_class') AS comment FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${rel} AND ${noExt('c.oid')} ORDER BY 1`))

  const serialSeqs = new Set<string>()
  for (const r of await rows(d, `
    SELECT c.relname AS tbl, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
      pg_get_expr(ad.adbin, ad.adrelid) AS dflt, col_description(c.oid, a.attnum) AS comment, a.attidentity AS ident, ${pgOpt('a', 'attgenerated')} AS gen,
      CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation THEN co.collname END AS coll,
      (SELECT s.relname FROM pg_depend dp JOIN pg_class s ON s.oid = dp.objid AND s.relkind = 'S'
        WHERE dp.refobjid = c.oid AND dp.refobjsubid = a.attnum AND dp.deptype = 'a' LIMIT 1) AS owned
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum LEFT JOIN pg_collation co ON co.oid = a.attcollation
    WHERE ${rel} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum`)) {
    const t = tables.get(String(r.tbl))
    if (!t) continue
    const dflt = str(r.dflt)
    const owned = str(r.owned)
    const m = dflt && /^nextval\('(.+)'::regclass\)$/.exec(dflt)
    const serial = !!owned && !!m && m[1].replace(/^"|"$/g, '') === owned
    if (serial) serialSeqs.add(owned!)
    const generated = r.gen === 's' ? dflt : null
    t.columns.push({
      name: String(r.name), type: String(r.type), nullable: !r.notnull, default: serial || generated ? null : dflt, comment: str(r.comment), collation: str(r.coll),
      extra: serial ? 'serial' : r.ident === 'a' ? 'identity always' : r.ident === 'd' ? 'identity' : null, generated, seq: serial ? owned! : undefined
    })
  }

  const arr = (side: 'conkey' | 'confkey', rel2: 'conrelid' | 'confrelid'): string =>
    `(SELECT json_agg(a.attname ORDER BY k.o) FROM unnest(con.${side}) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = con.${rel2} AND a.attnum = k.n)::text`
  for (const r of await rows(d, `
    SELECT c.relname AS tbl, con.conname AS name, con.contype AS kind, pg_get_constraintdef(con.oid) AS def, ${arr('conkey', 'conrelid')} AS cols,
      rc.relname AS ref_table, rn.nspname AS ref_schema, ${arr('confkey', 'confrelid')} AS ref_cols
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_class rc ON rc.oid = con.confrelid LEFT JOIN pg_namespace rn ON rn.oid = rc.relnamespace
    WHERE ${rel} AND con.contype IN ('p','u','f','c','x') AND con.conislocal ORDER BY 1, 2`)) {
    const c: SConstraint = { name: String(r.name), kind: PG_KIND[String(r.kind)], def: String(r.def), columns: json<string>(r.cols) }
    if (c.kind === 'fk') Object.assign(c, { refTable: str(r.ref_table), refSchema: r.ref_schema === schema ? null : str(r.ref_schema), refColumns: json<string>(r.ref_cols) })
    tables.get(String(r.tbl))?.constraints.push(c)
  }

  for (const r of await rows(d, `
    SELECT c.relname AS tbl, ic.relname AS name, i.indisunique AS uniq, pg_get_indexdef(i.indexrelid) AS def,
      (SELECT json_agg(a.attname) FROM unnest(i.indkey::int2[]) k(n) JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.n)::text AS cols
    FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ${rel} AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.conrelid = c.oid AND k.contype IN ('p','u','x'))
    ORDER BY 1, 2`)) {
    const def = String(r.def)
    tables.get(String(r.tbl))?.indexes.push({ name: String(r.name), def: def.slice(def.indexOf(' USING ') + 1), unique: !!r.uniq, columns: json<string>(r.cols) })
  }

  const views = (await rows(d, `SELECT c.relname AS name, c.relkind AS kind, pg_get_viewdef(c.oid, true) AS def FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${S} AND c.relkind IN ('v','m') AND ${noExt('c.oid')} ORDER BY 1`))
    .map((r) => ({ name: String(r.name), def: String(r.def).trim().replace(/;$/, ''), materialized: r.kind === 'm' }))

  const head = new RegExp(`^(CREATE OR REPLACE (?:FUNCTION|PROCEDURE) )${esc(qs)}\\.`)
  const routines = (await rows(d, `SELECT p.proname AS name, ${PG_PROKIND} AS kind, pg_get_function_identity_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS result, pg_get_functiondef(p.oid) AS def
    FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = ${S}) AND ${PG_PROKIND} IN ('f','p') AND ${noExt('p.oid')} ORDER BY 1, 3`))
    .map((r) => ({ name: String(r.name), kind: (r.kind === 'p' ? 'procedure' : 'function') as 'function' | 'procedure', args: String(r.args), result: str(r.result), def: String(r.def).trim().replace(head, '$1') }))

  const triggers = (await rows(d, `SELECT c.relname AS tbl, t.tgname AS name, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ${rel} AND NOT t.tgisinternal ORDER BY 1, 2`))
    .map((r) => ({ name: String(r.name), table: String(r.tbl), def: String(r.def).split(` ON ${qs}.`).join(' ON ') }))

  const sequences = (await rows(d, `SELECT c.relname AS name, format_type(s.seqtypid, NULL) AS type, s.seqstart::text AS start, s.seqincrement::text AS inc, s.seqmin::text AS min,
      s.seqmax::text AS max, s.seqcache::text AS cache, s.seqcycle AS cycle
    FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${S} AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.objid = c.oid AND e.deptype IN ('i','e')) ORDER BY 1`))
    .filter((r) => !serialSeqs.has(String(r.name)))
    .map((r) => ({ name: String(r.name), type: String(r.type), start: String(r.start), increment: String(r.inc), min: String(r.min), max: String(r.max), cache: String(r.cache), cycle: !!r.cycle }))

  const enums = (await rows(d, `SELECT t.typname AS name, json_agg(e.enumlabel ORDER BY e.enumsortorder)::text AS vals FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = ${S} AND ${noExt('t.oid')} GROUP BY t.typname ORDER BY 1`))
    .map((r) => ({ name: String(r.name), values: json<string>(r.vals) }))

  return { dialect: 'postgres', schema, lowerCaseNames: 0, tables: [...tables.values()], views, routines, triggers, sequences, enums }
}

/** Reads one database. Column facts come from information_schema; the DDL fragments from SHOW CREATE. */
export async function readMysql(d: SqlDriver, schema: string): Promise<SchemaModel> {
  const S = lit('mysql', schema)
  const q = (n: string): string => `${qi('mysql', schema)}.${qi('mysql', n)}`
  const lower = Number((await d.query('SELECT @@lower_case_table_names')).rows[0]?.[0] ?? 0)
  const tables = tableMap(await rows(d, `SELECT TABLE_NAME AS name, TABLE_COMMENT AS comment, TABLE_COLLATION AS coll FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${S} AND TABLE_TYPE = 'BASE TABLE' ORDER BY 1`))
  const parsed = new Map<string, ReturnType<typeof parseMysqlCreateTable>>()
  for (const t of tables.values()) {
    const p = parseMysqlCreateTable(String((await d.query(`SHOW CREATE TABLE ${q(t.name)}`)).rows[0][1]))
    Object.assign(t, { constraints: p.constraints, indexes: p.indexes, options: p.options })
    parsed.set(t.name, p)
  }
  for (const r of await rows(d, `SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt, EXTRA AS extra,
      COLUMN_COMMENT AS comment, COLLATION_NAME AS coll, GENERATION_EXPRESSION AS gen FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${S} ORDER BY TABLE_NAME, ORDINAL_POSITION`)) {
    const t = tables.get(String(r.tbl))
    if (!t) continue
    const dflt = str(r.dflt)
    t.columns.push({
      name: String(r.name), type: String(r.type), nullable: r.nullable === 'YES', default: dflt === 'NULL' ? null : dflt, comment: str(r.comment) || null, collation: str(r.coll),
      extra: String(r.extra ?? '').replace(/DEFAULT_GENERATED/i, '').trim().toLowerCase() || null, generated: str(r.gen) || null, def: parsed.get(t.name)!.columns.get(String(r.name))
    })
  }
  // views store their tables qualified with this database; strip it so another database compares equal
  const own = '`' + schema.replace(/`/g, '``') + '`.'
  const views = (await rows(d, `SELECT TABLE_NAME AS name, VIEW_DEFINITION AS def, CHECK_OPTION AS chk, SECURITY_TYPE AS sec FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ${S} ORDER BY 1`))
    .map((r) => ({ name: String(r.name), def: String(r.def ?? '').split(own).join(''), security: str(r.sec), check: str(r.chk) }))
  const routines: SRoutine[] = []
  for (const r of await rows(d, `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ${S} ORDER BY 1`)) {
    const kind = r.type === 'PROCEDURE' ? 'procedure' : 'function'
    const def = str((await d.query(`SHOW CREATE ${kind.toUpperCase()} ${q(String(r.name))}`)).rows[0]?.[2])
    // without a DEFINER the deploying user owns it (and no SUPER/SET_USER_ID privilege is needed)
    if (def) routines.push({ name: String(r.name), kind: kind as 'function' | 'procedure', args: '', result: null, def: def.replace(/^CREATE\s+DEFINER\s*=\s*(`[^`]*`|'[^']*'|\S+?)@(`[^`]*`|'[^']*'|\S+)\s+/i, 'CREATE ') })
  }
  const triggers = (await rows(d, `SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl, ACTION_TIMING AS timing, EVENT_MANIPULATION AS ev, ACTION_STATEMENT AS body
      FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ${S} ORDER BY EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORDER`))
    .map((r) => ({ name: String(r.name), table: String(r.tbl), def: `CREATE TRIGGER ${qi('mysql', String(r.name))} ${r.timing} ${r.ev} ON ${qi('mysql', String(r.tbl))} FOR EACH ROW ${r.body}` }))
  return { dialect: 'mysql', schema, lowerCaseNames: lower, tables: [...tables.values()], views, routines, triggers, sequences: [], enums: [] }
}

register({
  /** A private session for one side (own search_path / default database). `via` lends the password of an open workspace session of the same connection. */
  'structsync.open': async (c, connectionId: string, database?: string, via?: string, asked?: { password?: string; sshPassword?: string }) => {
    let lent: string | undefined
    try { if (via && session(via).conn.id === connectionId) lent = session(via).password } catch { /* workspace session gone: use the connection's own password rules */ }
    const r = await openSession(connectionId, undefined, { ...asked, password: asked?.password ?? lent }, database ? { database } : undefined)
    c.sender.once('destroyed', () => void closeSession(r.sessionId))
    return r
  },
  'structsync.read': (_c, sessionId: string, schema: string) => {
    const d = sqlDriver(sessionId)
    if (d.dialect === 'postgres') return readPostgres(d, schema)
    if (d.dialect === 'mysql') return readMysql(d, schema)
    throw new Error('Structure synchronization supports PostgreSQL, MySQL and MariaDB.')
  }
})
