// Pure Data Synchronization helpers: key ordering, value normalisation, the streamed merge-join diff and
// the INSERT/UPDATE/DELETE script for the target. Shared by main and the renderer. Tested in test/datasync.test.ts.
import type { Dialect } from './types'
import { insertSql, updateSql, deleteSql, type CellValue } from './sqlgen'
import { classify, convertValue, compatible, isNumericFam, utcPlain, type TypeInfo } from './transfer'

export type OpKind = 'insert' | 'update' | 'delete' | 'same'
/** Rows share one layout on both sides: key columns first, then the compared columns. */
export interface DiffOp { kind: OpKind; src: unknown[] | null; dst: unknown[] | null; changed: number[] }
export interface CompareOpts { ignoreCase?: boolean; ignoreSpace?: boolean }

/** Code point order (= UTF-8 byte order, what binary collations sort by). Plain `<` compares UTF-16 units. */
export function cmpStr(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i)
    const y = b.charCodeAt(i)
    if (x === y) continue
    const sx = x >= 0xd800 && x <= 0xdfff
    const sy = y >= 0xd800 && y <= 0xdfff
    if (sx !== sy) return sx ? 1 : -1
    return x - y
  }
  return a.length - b.length
}

const INT = /^-?\d+$/
function cmpOne(x: unknown, y: unknown, numeric: boolean): number {
  const a = String(x)
  const b = String(y)
  if (a === b) return 0
  if (numeric) {
    if (INT.test(a) && INT.test(b)) { const p = BigInt(a); const q = BigInt(b); return p < q ? -1 : p > q ? 1 : 0 }
    const p = Number(a)
    const q = Number(b)
    if (!isNaN(p) && !isNaN(q)) return p < q ? -1 : p > q ? 1 : 0
  }
  return cmpStr(a, b)
}

export function cmpKey(a: unknown[], b: unknown[], numeric: boolean[]): number {
  for (let i = 0; i < numeric.length; i++) {
    const c = cmpOne(a[i], b[i], numeric[i])
    if (c) return c
  }
  return 0
}

/** '1.50' → '1.5', '-0.0' → '0', '+007' → '7'. Non-numbers come back unchanged. */
export function canonNum(s: string): string {
  const m = /^\s*([+-]?)(\d*)(?:\.(\d*))?\s*$/.exec(s)
  if (!m || (!m[2] && !m[3])) return s
  const int = m[2].replace(/^0+/, '') || '0'
  const frac = (m[3] ?? '').replace(/0+$/, '')
  const out = frac ? `${int}.${frac}` : int
  return m[1] === '-' && out !== '0' ? `-${out}` : out
}

function canonJson(s: string): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v
  try { return JSON.stringify(sort(JSON.parse(s))) } catch { return s }
}

/** Comparable form of a cell, so the same value read from PG, MySQL or SQLite compares equal. */
export function normCell(v: unknown, t: TypeInfo, o: CompareOpts = {}): string | null {
  if (v === null || v === undefined) return null
  if (t.fam === 'bool') return v === true || /^(t|true|1)$/i.test(String(v)) ? '1' : '0'
  if (typeof v === 'boolean') return v ? '1' : '0'
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  // approximate types compare at their guaranteed precision (DBL_DIG / FLT_DIG); text formatting differs in the last digits
  if (t.fam === 'float' || t.fam === 'double') return isNaN(Number(s)) ? s : String(Number(Number(s).toPrecision(t.fam === 'float' ? 6 : 15)))
  if (isNumericFam(t.fam)) return canonNum(s)
  if (t.fam === 'json') return canonJson(s)
  if (t.fam === 'binary') return s.toLowerCase()
  if (t.fam === 'timestamp' || t.fam === 'timestamptz' || t.fam === 'time') return utcPlain(s.replace('T', ' ')).replace(/\.0*$/, '').replace(/(\.\d*?)0+$/, '$1')
  let r = s
  if (o.ignoreSpace) r = r.trim().replace(/\s+/g, ' ')
  if (o.ignoreCase) r = r.toLowerCase()
  return r
}

async function* rowsOf(pages: AsyncIterable<unknown[][]>): AsyncGenerator<unknown[]> {
  for await (const p of pages) yield* p
}

export interface MergeSpec { keyCount: number; types: TypeInfo[]; opts?: CompareOpts }

/**
 * Merge-join two key-ordered row streams (pages of arrays). Only one page per side is held at a time.
 * Throws when a side repeats a key or is not in the expected order (non-unique keys, or a collation we cannot follow).
 */
export async function* mergeDiff(src: AsyncIterable<unknown[][]>, dst: AsyncIterable<unknown[][]>, spec: MergeSpec): AsyncGenerator<DiffOp> {
  const numeric = spec.types.slice(0, spec.keyCount).map((t) => isNumericFam(t.fam))
  const a = rowsOf(src)
  const b = rowsOf(dst)
  const step = async (it: AsyncGenerator<unknown[]>, prev: unknown[] | undefined, side: string): Promise<unknown[] | undefined> => {
    const r = await it.next()
    if (r.done) return undefined
    if (prev && cmpKey(prev, r.value, numeric) >= 0)
      throw new Error(`The ${side} rows repeat a key or come back in an order that cannot be compared. Choose key columns that are unique (numbers or text work best).`)
    return r.value
  }
  try {
    let x = await step(a, undefined, 'source')
    let y = await step(b, undefined, 'target')
    while (x || y) {
      const c = !x ? 1 : !y ? -1 : cmpKey(x, y, numeric)
      if (c < 0) { yield { kind: 'insert', src: x!, dst: null, changed: [] }; x = await step(a, x, 'source') }
      else if (c > 0) { yield { kind: 'delete', src: null, dst: y!, changed: [] }; y = await step(b, y, 'target') }
      else {
        const changed: number[] = []
        for (let i = spec.keyCount; i < spec.types.length; i++) if (normCell(x![i], spec.types[i], spec.opts) !== normCell(y![i], spec.types[i], spec.opts)) changed.push(i)
        yield { kind: changed.length ? 'update' : 'same', src: x!, dst: y!, changed }
        x = await step(a, x, 'source')
        y = await step(b, y, 'target')
      }
    }
  } finally {
    // close both readers (ends a PG cursor's transaction) when the caller stops early or a side fails
    await a.return(undefined)
    await b.return(undefined)
  }
}

// ---------- table/column matching ----------
export interface ColInfo { name: string; type: string; pk?: boolean; extra?: string | null }

/** Target table for each source table: same name, then case-insensitive. */
export function matchTables(src: string[], dst: string[]): (string | null)[] {
  return src.map((s) => dst.find((d) => d === s) ?? dst.find((d) => d.toLowerCase() === s.toLowerCase()) ?? null)
}

/** Column pairs [source, target] present on both sides (exact name, then case-insensitive). */
export function commonColumns(src: ColInfo[], dst: ColInfo[]): [string, string][] {
  return src.flatMap((s) => {
    const d = dst.find((x) => x.name === s.name) ?? dst.find((x) => x.name.toLowerCase() === s.name.toLowerCase())
    return d ? [[s.name, d.name] as [string, string]] : []
  })
}

/** Default pairing for a table: keys = source primary key (if all of it exists on the target), compare = the other common columns. */
export function defaultPairing(src: ColInfo[], dst: ColInfo[], sd: Dialect, td: Dialect): { keys: string[]; cols: string[]; reason?: string } {
  const common = commonColumns(src, dst)
  const pk = src.filter((c) => c.pk).map((c) => c.name)
  const keys = pk.length && pk.every((k) => common.some(([s]) => s === k)) ? pk : []
  const generated = new Set(dst.filter((c) => c.extra === 'generated').map((c) => c.name))
  const cols = common.filter(([s, d]) => !keys.includes(s) && !generated.has(d) && compatible(classify(src.find((c) => c.name === s)!.type, sd), classify(dst.find((c) => c.name === d)!.type, td))).map(([s]) => s)
  return { keys, cols, reason: keys.length ? keyProblem(keys, src, dst, sd, td) : 'No primary key on both sides. Pick key columns.' }
}

/** Why these key columns cannot pair rows, or undefined when they can. */
export function keyProblem(keys: string[], src: ColInfo[], dst: ColInfo[], sd: Dialect, td: Dialect): string | undefined {
  if (!keys.length) return 'Pick at least one key column.'
  const common = commonColumns(src, dst)
  for (const k of keys) {
    const pair = common.find(([s]) => s === k)
    if (!pair) return `Key column ${k} is missing on the target.`
    const a = classify(src.find((c) => c.name === k)!.type, sd)
    const b = classify(dst.find((c) => c.name === pair[1])!.type, td)
    if (!compatible(a, b) || isNumericFam(a.fam) !== isNumericFam(b.fam)) return `Key column ${k} has incompatible types on the two sides.`
  }
  return undefined
}

// ---------- script ----------
export interface TableTarget { dialect: Dialect; schema: string; table: string; cols: string[]; types: string[]; keyCount: number }

/** The statement that applies one diff to the target. `same` rows produce nothing. */
export function opSql(t: TableTarget, op: DiffOp): string | null {
  const d = t.dialect
  const infos = t.types.map((x) => classify(x, d))
  const types = Object.fromEntries(t.cols.map((c, i) => [c, t.types[i]]))
  const val = (row: unknown[], i: number): CellValue => convertValue(row[i], infos[i], d)
  const key = (row: unknown[]): Record<string, CellValue> => Object.fromEntries(t.cols.slice(0, t.keyCount).map((c, i) => [c, val(row, i)]))
  if (op.kind === 'insert') return insertSql(d, t.schema, t.table, Object.fromEntries(t.cols.map((c, i) => [c, val(op.src!, i)])), types)
  if (op.kind === 'delete') return deleteSql(d, t.schema, t.table, key(op.dst!), types)
  if (op.kind === 'update') return updateSql(d, t.schema, t.table, key(op.dst!), Object.fromEntries(op.changed.map((i) => [t.cols[i], val(op.src!, i)])), types)
  return null
}
