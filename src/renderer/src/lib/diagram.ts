// ER diagram geometry, FK grouping and auto layout. Pure (type-only imports) so `node --test` can load it.
import type { Column, ForeignKey } from '@shared/types'

export interface DTable { name: string; columns: Column[]; fks: ForeignKey[] }
export interface Pos { x: number; y: number }
export type SortMode = 'name' | 'columns'

export const BOX_W = 240
export const HEAD_H = 28
export const ROW_H = 20
const GAP_X = 72
const GAP_Y = 56

export const boxHeight = (cols: number): number => HEAD_H + Math.max(1, cols) * ROW_H + 4

/** FK edges [from, to] between tables of this diagram (references into other schemas are ignored). */
export const edgesOf = (tables: DTable[], schema: string): [string, string][] => {
  const names = new Set(tables.map((t) => t.name))
  return tables.flatMap((t) => t.fks.filter((f) => names.has(f.refTable) && (!f.refSchema || f.refSchema === schema)).map((f) => [t.name, f.refTable] as [string, string]))
}

/** Connected components over FK edges. Tables without any FK get no entry (neutral colour). */
export function fkGroups(names: string[], edges: [string, string][]): Record<string, number> {
  const parent = new Map(names.map((n) => [n, n]))
  const find = (a: string): string => { while (parent.get(a) !== a) a = parent.get(a)!; return a }
  const linked = new Set<string>()
  for (const [a, b] of edges) {
    if (!parent.has(a) || !parent.has(b)) continue
    parent.set(find(a), find(b))
    linked.add(a).add(b)
  }
  const ids = new Map<string, number>()
  const out: Record<string, number> = {}
  for (const n of [...names].sort()) {
    if (!linked.has(n)) continue
    const r = find(n)
    if (!ids.has(r)) ids.set(r, ids.size)
    out[n] = ids.get(r)!
  }
  return out
}

/**
 * Grid layout: FK-connected tables are placed consecutively (BFS from the most connected table, bigger groups first),
 * unlinked tables last; `sort` orders tables inside that scheme. Rows are as tall as their tallest table.
 */
export function autoLayout(tables: { name: string; cols: number }[], edges: [string, string][], sort: SortMode, origin: Pos = { x: 40, y: 40 }): Record<string, Pos> {
  const cmp = (a: { name: string; cols: number }, b: { name: string; cols: number }): number => (sort === 'columns' ? b.cols - a.cols : 0) || a.name.localeCompare(b.name)
  const sorted = [...tables].sort(cmp)
  const byName = new Map(sorted.map((t) => [t.name, t]))
  const adj = new Map(sorted.map((t) => [t.name, new Set<string>()]))
  for (const [a, b] of edges) if (a !== b && adj.has(a) && adj.has(b)) { adj.get(a)!.add(b); adj.get(b)!.add(a) }
  const neighbours = (n: string): string[] => [...adj.get(n)!].map((x) => byName.get(x)!).sort(cmp).map((t) => t.name)

  const seen = new Set<string>()
  const comps: string[][] = []
  for (const t of sorted) {
    if (seen.has(t.name)) continue
    const members = new Set([t.name])
    for (const m of members) for (const nb of adj.get(m)!) members.add(nb)
    const start = [...members].sort((a, b) => adj.get(b)!.size - adj.get(a)!.size || cmp(byName.get(a)!, byName.get(b)!))[0]
    const order = [start]
    seen.add(start)
    for (let i = 0; i < order.length; i++) for (const nb of neighbours(order[i])) if (!seen.has(nb)) { seen.add(nb); order.push(nb) }
    comps.push(order)
  }
  comps.sort((a, b) => b.length - a.length) // stable: equal sizes keep the sort order
  const order = comps.flat()

  const perRow = Math.max(1, Math.min(8, Math.ceil(Math.sqrt(order.length))))
  const out: Record<string, Pos> = {}
  let y = origin.y
  for (let i = 0; i < order.length; i += perRow) {
    const row = order.slice(i, i + perRow)
    row.forEach((n, k) => (out[n] = { x: origin.x + k * (BOX_W + GAP_X), y }))
    y += Math.max(...row.map((n) => boxHeight(byName.get(n)!.cols))) + GAP_Y
  }
  return out
}

/** Saved positions win; tables without one are auto-laid out below the saved ones. */
export function mergeLayout(tables: { name: string; cols: number }[], edges: [string, string][], sort: SortMode, saved?: Record<string, Pos>): Record<string, Pos> {
  const known = tables.filter((t) => saved?.[t.name])
  const missing = tables.filter((t) => !saved?.[t.name])
  if (!known.length) return autoLayout(tables, edges, sort)
  const out: Record<string, Pos> = Object.fromEntries(known.map((t) => [t.name, saved![t.name]]))
  if (missing.length) {
    const bottom = Math.max(...known.map((t) => out[t.name].y + boxHeight(t.cols)))
    const left = Math.min(...known.map((t) => out[t.name].x))
    Object.assign(out, autoLayout(missing, edges, sort, { x: left, y: bottom + GAP_Y }))
  }
  return out
}

/** Cubic path from a column row of one box to a column row of another, leaving/entering on the facing sides. */
export function fkPath(from: Pos, fromRow: number, to: Pos, toRow: number, self: boolean): { d: string; end: Pos } {
  const y1 = from.y + HEAD_H + fromRow * ROW_H + ROW_H / 2
  const y2 = to.y + HEAD_H + toRow * ROW_H + ROW_H / 2
  if (self) {
    const x = from.x + BOX_W
    return { d: `M${x},${y1} C${x + 48},${y1} ${x + 48},${y2} ${x},${y2}`, end: { x, y: y2 } }
  }
  const right = to.x + BOX_W / 2 >= from.x + BOX_W / 2
  const x1 = right ? from.x + BOX_W : from.x
  const x2 = right ? to.x : to.x + BOX_W
  const c = Math.max(32, Math.abs(x2 - x1) / 2)
  return { d: `M${x1},${y1} C${x1 + (right ? c : -c)},${y1} ${x2 + (right ? -c : c)},${y2} ${x2},${y2}`, end: { x: x2, y: y2 } }
}

/** Bounding box of all boxes (for export and fit). */
export function bounds(tables: { name: string; cols: number }[], pos: Record<string, Pos>): { x: number; y: number; w: number; h: number } {
  const ps = tables.filter((t) => pos[t.name])
  if (!ps.length) return { x: 0, y: 0, w: 0, h: 0 }
  const x = Math.min(...ps.map((t) => pos[t.name].x))
  const y = Math.min(...ps.map((t) => pos[t.name].y))
  const x2 = Math.max(...ps.map((t) => pos[t.name].x + BOX_W + 56)) // room for self-reference loops
  const y2 = Math.max(...ps.map((t) => pos[t.name].y + boxHeight(t.cols)))
  return { x, y, w: x2 - x, h: y2 - y }
}
