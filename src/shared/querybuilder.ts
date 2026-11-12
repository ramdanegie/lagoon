// Visual query builder model → SELECT statement. Tables are joined in the order they were added; a table with no join
// to the ones before it becomes a CROSS JOIN. Tested in test/querybuilder.test.ts.
import type { Dialect } from './types'
import { qi, qt, lit, isNumericType } from './sqlgen'

export type JoinKind = 'INNER' | 'LEFT' | 'RIGHT' | 'FULL'
export type Agg = '' | 'COUNT' | 'COUNT DISTINCT' | 'SUM' | 'AVG' | 'MIN' | 'MAX'
export const AGGS: Agg[] = ['', 'COUNT', 'COUNT DISTINCT', 'SUM', 'AVG', 'MIN', 'MAX']
export const QB_OPS = ['=', '<>', '<', '>', '<=', '>=', 'LIKE', 'NOT LIKE', 'IN', 'NOT IN', 'IS NULL', 'IS NOT NULL'] as const
export type QbOp = (typeof QB_OPS)[number]

export interface QbTable { alias: string; schema: string; name: string; x: number; y: number }
export interface QbColumn { table: string; column: string; agg: Agg; as: string } // table = alias
export interface QbJoin { left: string; leftCol: string; right: string; rightCol: string; kind: JoinKind }
export interface QbFilter { table: string; column: string; type: string; op: QbOp; value: string }
export interface QbSort { table: string; column: string; dir: 'ASC' | 'DESC' }
export interface QbModel { tables: QbTable[]; columns: QbColumn[]; joins: QbJoin[]; where: QbFilter[]; whereJoin: 'AND' | 'OR'; sort: QbSort[]; distinct: boolean; limit: number | null }

export const emptyModel = (): QbModel => ({ tables: [], columns: [], joins: [], where: [], whereJoin: 'AND', sort: [], distinct: false, limit: null })

/** An alias for a newly added table: its name, or name_2, name_3… when the table is already on the canvas. */
export const nextAlias = (m: QbModel, name: string): string => {
  let a = name
  for (let i = 2; m.tables.some((t) => t.alias === a); i++) a = `${name}_${i}`
  return a
}

const FLIP: Record<JoinKind, JoinKind> = { INNER: 'INNER', FULL: 'FULL', LEFT: 'RIGHT', RIGHT: 'LEFT' }

export function buildSelect(d: Dialect, m: QbModel): string {
  if (!m.tables.length) return ''
  const col = (t: string, c: string): string => `${qi(d, t)}.${qi(d, c)}`
  const from = (t: QbTable): string => qt(d, t.schema, t.name) + (t.alias !== t.name ? ` AS ${qi(d, t.alias)}` : '')
  const expr = (c: QbColumn): string => {
    const e = col(c.table, c.column)
    const a = c.agg === 'COUNT DISTINCT' ? `COUNT(DISTINCT ${e})` : c.agg ? `${c.agg}(${e})` : e
    return c.as.trim() ? `${a} AS ${qi(d, c.as.trim())}` : a
  }
  const cols = m.columns.filter((c) => m.tables.some((t) => t.alias === c.table))
  const lines = [`SELECT${m.distinct ? ' DISTINCT' : ''} ${cols.length ? cols.map(expr).join(',\n       ') : '*'}`, `FROM ${from(m.tables[0])}`]
  const placed = [m.tables[0].alias]
  for (const t of m.tables.slice(1)) {
    const links = m.joins.filter((j) => (j.right === t.alias && placed.includes(j.left)) || (j.left === t.alias && placed.includes(j.right)))
    if (!links.length) lines.push(`CROSS JOIN ${from(t)}`)
    else {
      // the first link decides the kind; seen from the new table, LEFT and RIGHT swap when it was the link's left side
      const kind = links[0].right === t.alias ? links[0].kind : FLIP[links[0].kind]
      const on = links.map((j) => `${col(j.left, j.leftCol)} = ${col(j.right, j.rightCol)}`).join(' AND ')
      lines.push(`${kind === 'INNER' ? 'INNER' : `${kind} OUTER`} JOIN ${from(t)} ON ${on}`)
    }
    placed.push(t.alias)
  }
  const conds = m.where.filter((f) => m.tables.some((t) => t.alias === f.table)).map((f) => {
    const c = col(f.table, f.column)
    if (f.op === 'IS NULL' || f.op === 'IS NOT NULL') return `${c} ${f.op}`
    if (f.op === 'IN' || f.op === 'NOT IN') return `${c} ${f.op} (${f.value.split(',').map((v) => lit(d, v.trim(), f.type)).join(', ')})`
    return `${c} ${f.op} ${lit(d, isNumericType(f.type) ? f.value.trim() : f.value, f.type)}`
  })
  if (conds.length) lines.push(`WHERE ${conds.join(`\n  ${m.whereJoin} `)}`)
  if (cols.some((c) => c.agg) && cols.some((c) => !c.agg)) lines.push(`GROUP BY ${cols.filter((c) => !c.agg).map((c) => col(c.table, c.column)).join(', ')}`)
  const sort = m.sort.filter((s) => m.tables.some((t) => t.alias === s.table))
  if (sort.length) lines.push(`ORDER BY ${sort.map((s) => `${col(s.table, s.column)} ${s.dir}`).join(', ')}`)
  if (m.limit) lines.push(`LIMIT ${Math.floor(m.limit)}`)
  return lines.join('\n') + ';'
}
