// Test data generator (inspect / preview / Copy as SQL / background job) and the data dictionary collector.
import type { Column, ForeignKey } from '@shared/types'
import { lit } from '@shared/sqlgen'
import { runPlan, parseCheckIn, type GenPlan, type TableGen } from '@shared/datagen'
import type { Dict, DictTable } from '@shared/dictionary'
import { register } from './rpc'
import { session, sqlDriver } from './sessions'
import { startJob, jobDriver } from './jobs'
import type { SqlDriver } from './drivers/types'

const rows = async (d: SqlDriver, sql: string): Promise<string[][]> => (await d.query(sql)).rows.map((r) => r.map((v) => (v == null ? '' : String(v))))

/** Allowed values per column: Postgres enum types, plus simple CHECK (col IN (...)) constraints. Best effort. */
async function enumValues(d: SqlDriver, schema: string, table: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}
  const s = lit(d.dialect, schema)
  const t = lit(d.dialect, table)
  let checks: string[]
  if (d.dialect === 'postgres') {
    for (const [c, v] of await rows(d, `SELECT a.attname, e.enumlabel FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_enum e ON e.enumtypid = a.atttypid WHERE n.nspname = ${s} AND c.relname = ${t} ORDER BY a.attnum, e.enumsortorder`)) (out[c] ??= []).push(v)
    checks = (await rows(d, `SELECT pg_get_constraintdef(con.oid) FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE con.contype = 'c' AND n.nspname = ${s} AND c.relname = ${t}`)).map((r) => r[0])
  } else if (d.dialect === 'mysql') {
    // CHECK constraints exist from MySQL 8.0.16 / MariaDB 10.2; older servers just have none
    checks = (await rows(d, `SELECT cc.CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS cc JOIN information_schema.TABLE_CONSTRAINTS tc
      ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME WHERE tc.TABLE_SCHEMA = ${s} AND tc.TABLE_NAME = ${t}`).catch(() => [])).map((r) => r[0])
  } else checks = (await d.ddl(schema, table, 'table')).split(/\bCHECK\s*\(/i).slice(1)
  for (const c of checks) {
    const m = parseCheckIn(c)
    if (m && !out[m.column]) out[m.column] = m.values
  }
  return out
}

/** SQLite FKs may leave the referenced column blank (implicit primary key): fill it in. */
async function resolveFks(d: SqlDriver, fks: ForeignKey[]): Promise<ForeignKey[]> {
  return Promise.all(fks.map(async (f) => {
    if (f.refColumns.every(Boolean)) return f
    const pk = (await d.columns(f.refSchema, f.refTable)).filter((c) => c.pk).map((c) => c.name)
    return { ...f, refColumns: f.refColumns.map((c, i) => c || pk[i] || '') }
  }))
}

// ---------- data dictionary ----------
async function tableComments(d: SqlDriver, schema: string): Promise<Record<string, string>> {
  const s = lit(d.dialect, schema)
  const r = d.dialect === 'postgres'
    ? await rows(d, `SELECT c.relname, obj_description(c.oid, 'pg_class') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${s} AND obj_description(c.oid, 'pg_class') IS NOT NULL`)
    : d.dialect === 'mysql' ? await rows(d, `SELECT TABLE_NAME, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${s} AND TABLE_TYPE <> 'VIEW' AND TABLE_COMMENT <> ''`) : []
  return Object.fromEntries(r)
}

async function routines(d: SqlDriver, schema: string): Promise<Dict['routines']> {
  const s = lit(d.dialect, schema)
  if (d.dialect === 'postgres')
    return (await rows(d, `SELECT p.proname, p.prokind, pg_get_function_identity_arguments(p.oid), COALESCE(pg_get_function_result(p.oid), '') FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ${s} AND p.prokind IN ('f','p') ORDER BY 1, 3`))
      .map(([name, k, args, ret]) => ({ name, kind: k === 'p' ? 'procedure' : 'function', signature: `${name}(${args})${ret ? ` → ${ret}` : ''}` }))
  if (d.dialect === 'mysql')
    return (await rows(d, `SELECT r.ROUTINE_NAME, r.ROUTINE_TYPE, COALESCE(r.DTD_IDENTIFIER, ''),
        COALESCE(GROUP_CONCAT(CONCAT_WS(' ', p.PARAMETER_MODE, p.PARAMETER_NAME, p.DTD_IDENTIFIER) ORDER BY p.ORDINAL_POSITION SEPARATOR ', '), '')
      FROM information_schema.ROUTINES r LEFT JOIN information_schema.PARAMETERS p
        ON p.SPECIFIC_SCHEMA = r.ROUTINE_SCHEMA AND p.SPECIFIC_NAME = r.SPECIFIC_NAME AND p.ORDINAL_POSITION > 0
      WHERE r.ROUTINE_SCHEMA = ${s} GROUP BY r.ROUTINE_NAME, r.ROUTINE_TYPE, r.DTD_IDENTIFIER ORDER BY 1`))
      .map(([name, k, ret, args]) => ({ name, kind: k === 'PROCEDURE' ? 'procedure' : 'function', signature: `${name}(${args})${ret ? ` → ${ret}` : ''}` }))
  return []
}

async function buildDict(sessionId: string, schema: string): Promise<Dict> {
  const d = sqlDriver(sessionId)
  const objs = await d.objects(schema)
  const comments = await tableComments(d, schema)
  const items: DictTable[] = []
  for (const o of objs) {
    if (o.kind !== 'table' && o.kind !== 'view' && o.kind !== 'matview') continue
    const columns: Column[] = await d.columns(schema, o.name)
    const isTable = o.kind === 'table'
    items.push({
      name: o.name, kind: o.kind, comment: comments[o.name] ?? null, columns,
      rows: isTable ? await d.estimateCount(schema, o.name).catch(() => null) : null,
      indexes: o.kind === 'view' ? [] : await d.indexes(schema, o.name).catch(() => []),
      fks: isTable ? await d.foreignKeys(schema, o.name) : [],
      definition: isTable ? undefined : await d.ddl(schema, o.name, o.kind).catch((e) => `-- ${(e as Error).message}`)
    })
  }
  return {
    connection: session(sessionId).conn.name, database: d.currentDatabase(), schema, dialect: d.dialect, generatedAt: new Date().toISOString(),
    tables: items.filter((x) => x.kind === 'table'), views: items.filter((x) => x.kind !== 'table'), routines: await routines(d, schema)
  }
}

register({
  /** Columns, FKs (referenced column filled in), single-column unique keys and allowed values for one table. */
  'gen.inspect': async (_c, s: string, schema: string, table: string) => {
    const d = sqlDriver(s)
    const columns = await d.columns(schema, table)
    const fks = await resolveFks(d, await d.foreignKeys(schema, table))
    // read directly on Postgres: Index.columns from the driver is off by one there (int2vector subscripts start at 0)
    const unique = d.dialect === 'postgres'
      ? (await rows(d, `SELECT a.attname FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0] WHERE i.indisunique AND i.indnatts = 1
          AND n.nspname = ${lit(d.dialect, schema)} AND c.relname = ${lit(d.dialect, table)}`)).map((r) => r[0])
      : (await d.indexes(schema, table)).filter((i) => i.unique && i.columns.length === 1).map((i) => i.columns[0])
    return { columns, fks, unique, enums: await enumValues(d, schema, table).catch(() => ({})) }
  },
  /** First rows of one table, FK values from the rows that exist now. */
  'gen.preview': async (_c, s: string, schema: string, t: TableGen, seed: number) => {
    let out: { columns: string[]; rows: unknown[][] } = { columns: [], rows: [] }
    await runPlan(sqlDriver(s), { schema, seed, deleteFirst: false, tables: [{ ...t, rows: Math.min(t.rows, 20) }] }, { execute: false, onRows: (_t, columns, r) => { out = { columns, rows: r } } })
    return out
  },
  'gen.sql': async (_c, s: string, plan: GenPlan) => {
    const { sql } = await runPlan(sqlDriver(s), plan, { execute: false })
    return sql.map((x) => x + ';\n').join('\n')
  },
  /** One transaction on a private connection: all rows land, or none. */
  'gen.run': (c, s: string, plan: GenPlan) => {
    const live = plan.tables.filter((t) => t.rows > 0)
    if (!live.length) throw new Error('Choose at least one table with rows to generate.')
    return startJob(c.sender, 'generate', `Generate data for ${live.length === 1 ? live[0].table : `${live.length} tables`}`, async (j) => {
      const { d, close } = await jobDriver(s)
      try {
        await d.query(d.dialect === 'mysql' ? 'START TRANSACTION' : 'BEGIN')
        try {
          const r = await runPlan(d, plan, { execute: true, cancelled: () => j.cancelled, progress: (n, total, table) => j.progress(n / total, `${table}: ${n} of ${total} rows`) })
          await d.query('COMMIT')
          return { message: `Inserted ${r.rows} row${r.rows === 1 ? '' : 's'} into ${live.length} table${live.length === 1 ? '' : 's'}` }
        } catch (e) {
          await d.query('ROLLBACK').catch(() => {})
          throw e
        }
      } finally { await close() }
    })
  },
  'dict.build': (_c, s: string, schema: string) => buildDict(s, schema)
})
