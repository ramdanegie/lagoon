// Search in database. Data: COUNT(*) of rows where any column matches, one table at a time, pausable.
// Structure: names of tables, views, columns, indexes and functions (optionally view/function definitions).
import type { FilterOp, ObjectKind } from '@shared/types'
import { filterSql, qi, qt, lit } from '@shared/sqlgen'
import { nameMatcher, type NameMode } from '@shared/dictionary'
import { register } from './rpc'
import { sqlDriver } from './sessions'
import type { SqlDriver } from './drivers/types'

interface Job { paused: boolean; stopped: boolean; wake?: () => void }
const jobs = new Map<string, Job>()
const OPS: FilterOp[] = ['Contains', 'Not contains', '=', 'Has prefix', 'Has suffix']

const poke = (id: string, f: (j: Job) => void): void => {
  const j = jobs.get(id)
  if (j) { f(j); j.wake?.() }
}

export interface StructHit { kind: 'table' | 'view' | 'column' | 'index' | 'function'; name: string; objKind: ObjectKind; table?: string; inDefinition?: boolean }

const strRows = async (d: SqlDriver, sql: string): Promise<string[][]> => (await d.query(sql)).rows.map((r) => r.map((v) => (v == null ? '' : String(v))))

async function structureSearch(d: SqlDriver, schema: string, text: string, mode: NameMode, matchCase: boolean, definitions: boolean): Promise<StructHit[]> {
  const hit = nameMatcher(text, mode, matchCase)
  const s = lit(d.dialect, schema)
  const objs = await d.objects(schema)
  const kindOf = new Map(objs.map((o) => [o.name, o.kind]))
  const out: StructHit[] = []
  for (const o of objs) {
    if (!hit(o.name)) continue
    if (o.kind === 'table') out.push({ kind: 'table', name: o.name, objKind: o.kind })
    else if (o.kind === 'view' || o.kind === 'matview') out.push({ kind: 'view', name: o.name, objKind: o.kind })
    else if (o.kind === 'function' || o.kind === 'procedure') out.push({ kind: 'function', name: o.name, objKind: o.kind })
  }
  let cols: string[][] // [table, column]
  let idx: string[][] // [table, index]
  let defs: string[][] = [] // [name, kind, definition]
  if (d.dialect === 'sqlite') {
    cols = []
    for (const o of objs) for (const c of await d.columns(schema, o.name)) cols.push([o.name, c.name])
    idx = await strRows(d, `SELECT tbl_name, name FROM ${qi(d.dialect, schema)}.sqlite_master WHERE type = 'index'`)
    if (definitions) defs = await strRows(d, `SELECT name, 'view', sql FROM ${qi(d.dialect, schema)}.sqlite_master WHERE type = 'view'`)
  } else {
    cols = await strRows(d, `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = ${s} ORDER BY table_name, ordinal_position`)
    if (d.dialect === 'postgres') {
      idx = await strRows(d, `SELECT tablename, indexname FROM pg_indexes WHERE schemaname = ${s}`)
      if (definitions) defs = await strRows(d, `SELECT viewname, 'view', definition FROM pg_views WHERE schemaname = ${s}
        UNION ALL SELECT matviewname, 'matview', definition FROM pg_matviews WHERE schemaname = ${s}
        UNION ALL SELECT p.proname, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END, pg_get_functiondef(p.oid) FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ${s} AND p.prokind IN ('f','p')`)
    } else {
      idx = await strRows(d, `SELECT DISTINCT TABLE_NAME, INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ${s}`)
      if (definitions) defs = await strRows(d, `SELECT TABLE_NAME, 'view', VIEW_DEFINITION FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ${s}
        UNION ALL SELECT ROUTINE_NAME, LOWER(ROUTINE_TYPE), COALESCE(ROUTINE_DEFINITION, '') FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ${s}`)
    }
  }
  for (const [t, c] of cols) if (hit(c)) out.push({ kind: 'column', name: c, table: t, objKind: kindOf.get(t) ?? 'table' })
  for (const [t, i] of idx) if (hit(i)) out.push({ kind: 'index', name: i, table: t, objKind: kindOf.get(t) ?? 'table' })
  for (const [name, k, def] of defs) {
    if (hit(name) || !hit(def)) continue // name matches are already listed
    const objKind = k as ObjectKind
    out.push({ kind: objKind === 'function' || objKind === 'procedure' ? 'function' : 'view', name, objKind, inDefinition: true })
  }
  const seen = new Set<string>() // overloaded functions appear once
  return out.filter((h) => { const k = `${h.kind}:${h.table ?? ''}:${h.name}`; return !seen.has(k) && !!seen.add(k) }).slice(0, 2000)
}

register({
  'search.structure': (_c, s: string, schema: string, text: string, mode: NameMode, matchCase: boolean, definitions: boolean) =>
    structureSearch(sqlDriver(s), schema, text, mode, matchCase, definitions),
  /** Starts in the background; progress arrives as 'search:result' events, the last one has finished: true. */
  'search.start': (c, s: string, searchId: string, tables: { schema: string; name: string }[], op: FilterOp, value: string) => {
    if (!OPS.includes(op)) throw new Error(`Unsupported match type ${op}`)
    sqlDriver(s) // fail fast on a closed or non-SQL session
    const job: Job = { paused: false, stopped: false }
    jobs.set(searchId, job)
    const send = (msg: Record<string, unknown>): void => { if (!c.sender.isDestroyed()) c.sender.send('search:result', { searchId, total: tables.length, ...msg }) }
    void (async () => {
      for (let i = 0; i < tables.length; i++) {
        while (job.paused && !job.stopped) await new Promise<void>((r) => (job.wake = r))
        if (job.stopped) break
        const { schema, name } = tables[i]
        try {
          // shortcut: runs on the session connection, so it queues behind (and delays) the user's own queries; stop waits for the current table
          const d = sqlDriver(s)
          const cols = await d.columns(schema, name)
          const where = filterSql(d.dialect, { id: '', enabled: true, column: '__any__', op, value }, cols)
          const count = cols.length ? Number((await d.query(`SELECT COUNT(*) FROM ${qt(d.dialect, schema, name)} WHERE ${where}`)).rows[0]?.[0] ?? 0) : 0
          send({ schema, table: name, count, done: i + 1 })
        } catch (e) {
          send({ schema, table: name, error: (e as Error).message, done: i + 1 })
        }
      }
      jobs.delete(searchId)
      send({ finished: true, stopped: job.stopped })
    })()
  },
  'search.pause': (_c, id: string) => poke(id, (j) => (j.paused = true)),
  'search.resume': (_c, id: string) => poke(id, (j) => (j.paused = false)),
  'search.stop': (_c, id: string) => poke(id, (j) => (j.stopped = true))
})
