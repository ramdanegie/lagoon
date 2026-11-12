// Inline editing of query results: a SELECT from one table whose result includes the table's key can be edited
// cell by cell like the table view, with changes staged until saved.
import { useCallback, useState } from 'react'
import type { Column, Dialect, Index, ResultColumn } from '@shared/types'
import { singleTableOf } from '@shared/split'
import { deleteSql, insertSql, updateSql, type CellValue } from '@shared/sqlgen'
import { call } from './api'

export interface EditTarget {
  schema: string
  table: string
  types: Record<string, string>
  key: string[] // key columns (all present in the result)
  editable: Set<number> // result column indexes that map to real, writable table columns
}

export type Why = { ok: true; target: EditTarget } | { ok: false; reason: string }

/** Decide whether a result can be edited, and how rows are identified. */
export async function resolveEditTarget(sessionId: string, sql: string, defaultSchema: string | undefined, cols: ResultColumn[]): Promise<Why> {
  const ref = singleTableOf(sql)
  if (!ref) return { ok: false, reason: 'Only results of a SELECT from a single table can be edited.' }
  // ask the server which table the name means (Postgres search_path, folded case, quoting); fall back to the open schema
  const found = await call<{ schema: string; table: string } | null>('db.resolveTable', sessionId, ref).catch(() => null)
  const t = found ?? { schema: ref.schema ?? defaultSchema ?? '', table: ref.table }
  const schema = t.schema
  let tableCols: Column[]
  try {
    tableCols = await call<Column[]>('db.columns', sessionId, schema, t.table)
  } catch {
    return { ok: false, reason: `Couldn't read the columns of ${t.table}.` }
  }
  if (!tableCols.length) return { ok: false, reason: `${t.table} is not a table that can be edited.` }
  const names = cols.map((c) => c.name)
  let key = tableCols.filter((c) => c.pk).map((c) => c.name)
  if (!key.length) {
    const ix = await call<Index[]>('db.indexes', sessionId, schema, t.table).catch(() => [] as Index[])
    key = ix.find((i) => i.unique && i.columns.every((n) => tableCols.find((c) => c.name === n && !c.nullable)))?.columns ?? []
  }
  if (!key.length) return { ok: false, reason: `${t.table} has no primary or unique key, so rows can't be identified safely.` }
  const missing = key.filter((k) => !names.includes(k))
  if (missing.length) return { ok: false, reason: `Add the key column${missing.length > 1 ? 's' : ''} ${missing.join(', ')} to the SELECT to edit these rows.` }
  if (new Set(names).size !== names.length) return { ok: false, reason: 'The result has duplicate column names.' }
  const editable = new Set<number>()
  cols.forEach((c, i) => {
    const tc = tableCols.find((x) => x.name === c.name)
    if (tc && tc.extra !== 'generated') editable.add(i)
  })
  return { ok: true, target: { schema, table: t.table, key, types: Object.fromEntries(tableCols.map((c) => [c.name, c.type])), editable } }
}

export interface Snap { edits: Map<number, Map<number, CellValue>>; deleted: Set<number>; inserted: unknown[][] }
const empty = (): Snap => ({ edits: new Map(), deleted: new Set(), inserted: [] })
const clone = (s: Snap): Snap => ({ edits: new Map([...s.edits].map(([k, v]) => [k, new Map(v)])), deleted: new Set(s.deleted), inserted: s.inserted.map((r) => [...r]) })

/** Staged changes over a base row set (base rows first, inserted rows after). */
export function usePendingRows(base: unknown[][], width: number) {
  const [snap, setSnap] = useState<Snap>(empty)
  const mutate = useCallback((fn: (s: Snap) => void) => setSnap((cur) => { const n = clone(cur); fn(n); return n }), [])
  const setCell = (r: number, c: number, v: CellValue): void => mutate((s) => {
    const m = s.edits.get(r) ?? new Map()
    const orig = r < base.length ? base[r][c] : undefined
    if (r < base.length && typeof v !== 'object' && v !== null && orig !== null && String(orig ?? '') === v) m.delete(c)
    else m.set(c, v)
    if (m.size) s.edits.set(r, m); else s.edits.delete(r)
  })
  const addRow = (): void => mutate((s) => { s.inserted.push(Array.from({ length: width }, () => null)) })
  const toggleDelete = (rows: number[]): void => mutate((s) => {
    const all = rows.every((r) => s.deleted.has(r))
    rows.forEach((r) => (all ? s.deleted.delete(r) : s.deleted.add(r)))
  })
  const count = snap.deleted.size + snap.inserted.filter((_, i) => !snap.deleted.has(base.length + i)).length + [...snap.edits.keys()].filter((r) => r < base.length && !snap.deleted.has(r)).length
  return { snap, setCell, addRow, toggleDelete, reset: () => setSnap(empty()), count }
}

/** UPDATE / DELETE / INSERT statements for the staged changes. */
export function dmlFor(d: Dialect, t: EditTarget, cols: ResultColumn[], base: unknown[][], s: Snap): string[] {
  const idx = (n: string): number => cols.findIndex((c) => c.name === n)
  const keyOf = (r: number): Record<string, CellValue> => Object.fromEntries(t.key.map((k) => [k, (base[r][idx(k)] ?? null) as CellValue]))
  const named = (m: Map<number, CellValue>): Record<string, CellValue> => Object.fromEntries([...m].filter(([c]) => t.editable.has(c)).map(([c, v]) => [cols[c].name, v]))
  const out: string[] = []
  for (const [r, m] of s.edits) if (r < base.length && !s.deleted.has(r)) { const set = named(m); if (Object.keys(set).length) out.push(updateSql(d, t.schema, t.table, keyOf(r), set, t.types)) }
  for (const r of [...s.deleted].sort((a, b) => a - b)) if (r < base.length) out.push(deleteSql(d, t.schema, t.table, keyOf(r), t.types))
  s.inserted.forEach((_, i) => { const r = base.length + i; if (!s.deleted.has(r)) out.push(insertSql(d, t.schema, t.table, named(s.edits.get(r) ?? new Map()), t.types)) })
  return out
}
