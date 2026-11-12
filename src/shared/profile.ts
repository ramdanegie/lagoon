// Data profiling: per-column statistics (nulls, distinct, min/max/avg, text length, top values, histogram).
// SQL builders and result readers are pure; main runs them. Tested in test/profile.test.ts.
import type { Dialect } from './types'
import { qi, qt, isNumericType } from './sqlgen'

export interface ColumnProfile {
  total: number
  nulls: number
  distinct: number
  min: string | null
  max: string | null
  avg: number | null
  minLen: number | null
  maxLen: number | null
  top: { v: string | null; n: number }[]
  hist: { from: number; to: number; n: number }[]
}

const isText = (t: string): boolean => /char|text|clob|string|enum|citext/i.test(t)
const asText = (d: Dialect, e: string): string => (d === 'postgres' ? `CAST(${e} AS TEXT)` : d === 'mysql' ? `CAST(${e} AS CHAR)` : e)
/** The values looked at, as column `v`: the whole table, or its first `sample` rows. */
const source = (d: Dialect, schema: string, table: string, col: string, sample: number | null): string =>
  `(SELECT ${qi(d, col)} AS v FROM ${qt(d, schema, table)}${sample ? ` LIMIT ${Math.floor(sample)}` : ''}) s`

/** `plain`: compare as text, for types without ordering or equality (json, Postgres booleans). */
export function profileSql(d: Dialect, schema: string, table: string, col: string, type: string, sample: number | null, plain = false): { stats: string; top: string } {
  const src = source(d, schema, table, col, sample)
  const v = plain ? asText(d, 'v') : 'v'
  const len = d === 'mysql' ? 'CHAR_LENGTH(v)' : 'length(v)'
  return {
    stats: `SELECT count(*), count(v), count(DISTINCT ${v}), min(${v}), max(${v}), ${isNumericType(type) && !plain ? 'avg(v)' : 'NULL'}, ${isText(type) ? `min(${len}), max(${len})` : 'NULL, NULL'} FROM ${src}`,
    top: `SELECT ${asText(d, 'v')}, count(*) FROM ${src} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`
  }
}

export const HIST_BUCKETS = 10
export function histSql(d: Dialect, schema: string, table: string, col: string, min: number, max: number, sample: number | null): string {
  const w = (max - min) / HIST_BUCKETS
  // v - min is never negative, so SQLite's truncating cast is a floor too
  const b = d === 'sqlite' ? `CAST((v - ${min}) / ${w} AS INTEGER)` : `FLOOR((v - ${min}) / ${w})`
  return `SELECT ${b}, count(*) FROM ${source(d, schema, table, col, sample)} WHERE v IS NOT NULL GROUP BY 1 ORDER BY 1`
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v))
const str = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v))

export function readProfile(stats: unknown[], top: unknown[][], hist: unknown[][] = [], range?: { min: number; max: number }): ColumnProfile {
  const [total, nonNull, distinct, min, max, avg, minLen, maxLen] = stats
  const buckets = Array.from({ length: hist.length ? HIST_BUCKETS : 0 }, (_x, i) => {
    const w = range ? (range.max - range.min) / HIST_BUCKETS : 0
    return { from: (range?.min ?? 0) + i * w, to: (range?.min ?? 0) + (i + 1) * w, n: 0 }
  })
  // the maximum itself lands one past the last bucket; it belongs in the last one
  for (const [b, n] of hist) if (buckets.length) buckets[Math.min(HIST_BUCKETS - 1, Math.max(0, Number(b)))].n += Number(n)
  return {
    total: Number(total), nulls: Number(total) - Number(nonNull), distinct: Number(distinct),
    min: str(min), max: str(max), avg: num(avg), minLen: num(minLen), maxLen: num(maxLen),
    top: top.map(([v, n]) => ({ v: str(v), n: Number(n) })),
    hist: buckets
  }
}
