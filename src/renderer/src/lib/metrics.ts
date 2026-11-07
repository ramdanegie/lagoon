// Metrics board model + pure helpers. Only type imports at the top level so `node --test` can load this file.
import type { ResultColumn } from '@shared/types'

export type DataType = 'table' | 'scoreboard' | 'bar' | 'line' | 'pie'
export type ObjType = DataType | 'input' | 'dropdown' | 'button' | 'exporter'
/** seconds between reloads, 'event' = only when a linked control fires, 'manual' = load once */
export type Refresh = number | 'event' | 'manual'

export interface BoardObject {
  id: string
  type: ObjType
  frame: { x: number; y: number; w: number; h: number }
  label: string
  query?: string
  x?: string // bar/line x column, pie label column
  y?: string[] // bar/line y columns, pie value column (first)
  score?: string
  detail?: string
  refresh?: Refresh
  varName?: string // input / dropdown
  submit?: 'enter' | 'blur' | 'change' | 'event'
  value?: string // last value of an input / dropdown
  options?: string // dropdown fixed list, comma separated
  optionsQuery?: string // dropdown options from the first column of this query
  format?: 'csv' | 'json' // exporter
}

export interface BoardLink { from: string; to: string }
export interface Board { objects: BoardObject[]; links: BoardLink[]; locked?: boolean; grid?: boolean; updatedAt?: number }
export interface BoardRow { id: string; name: string; connectionId: string | null; board: Board }

export const DATA_TYPES: DataType[] = ['table', 'scoreboard', 'bar', 'line', 'pie']
export const isData = (t: ObjType): t is DataType => (DATA_TYPES as string[]).includes(t)
export const isControl = (t: ObjType): boolean => t === 'input' || t === 'dropdown' || t === 'button'

export const OBJ_LABELS: Record<ObjType, string> = {
  table: 'Data table', scoreboard: 'Scoreboard', bar: 'Bar chart', line: 'Line chart', pie: 'Pie chart',
  input: 'Input field', dropdown: 'Dropdown', button: 'Button', exporter: 'Exporter'
}

export const REFRESH_CHOICES: { value: Refresh; label: string }[] = [
  { value: 1, label: 'Every second' }, { value: 5, label: 'Every 5 seconds' }, { value: 10, label: 'Every 10 seconds' }, { value: 30, label: 'Every 30 seconds' },
  { value: 60, label: 'Every minute' }, { value: 300, label: 'Every 5 minutes' }, { value: 600, label: 'Every 10 minutes' }, { value: 1800, label: 'Every 30 minutes' },
  { value: 'event', label: 'On event' }, { value: 'manual', label: 'Manual' }
]

export const GRID = 8
export const snap = (n: number): number => Math.max(0, Math.round(n / GRID) * GRID)

const SIZES: Record<ObjType, [number, number]> = {
  table: [480, 280], scoreboard: [224, 136], bar: [480, 280], line: [480, 280], pie: [360, 280],
  input: [240, 72], dropdown: [240, 72], button: [160, 64], exporter: [200, 72]
}

/** A new object at (x, y), or stacked below everything on the board. */
export function newObject(type: ObjType, id: string, existing: BoardObject[], at?: { x: number; y: number }): BoardObject {
  const [w, h] = SIZES[type]
  const y = at ? snap(at.y) : existing.reduce((m, o) => Math.max(m, o.frame.y + o.frame.h + 16), 16)
  return {
    id, type, label: OBJ_LABELS[type], frame: { x: at ? snap(at.x) : 16, y: snap(y), w, h },
    ...(isData(type) ? { query: '', refresh: 'manual' as Refresh } : {}),
    ...(type === 'input' ? { varName: 'input', submit: 'enter' as const } : {}),
    ...(type === 'dropdown' ? { varName: 'option', submit: 'change' as const, options: '' } : {}),
    ...(type === 'exporter' ? { format: 'csv' as const } : {})
  }
}

const NUMERIC = /^\s*-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/
/** Numbers, numeric strings (pg returns numeric/bigint as text) and booleans become numbers; anything else null. */
export function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string' && NUMERIC.test(v)) return Number(v)
  return null
}

export const cellText = (v: unknown): string => (v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v))

export interface ChartData { x: string; y: string[]; data: Record<string, string | number | null>[] }

/** Map result rows to recharts records. Defaults: x = first column, y = columns whose first values are numeric. */
export function chartData(columns: Pick<ResultColumn, 'name'>[], rows: unknown[][], x?: string, y?: string[]): ChartData {
  const names = columns.map((c) => c.name)
  const xi = Math.max(0, x ? names.indexOf(x) : 0)
  const xName = names[xi] ?? ''
  let ys = (y ?? []).filter((n) => names.includes(n))
  if (!ys.length) ys = names.filter((_n, i) => i !== xi && rows.slice(0, 20).some((r) => toNum(r[i]) !== null))
  const idx = ys.map((n) => names.indexOf(n))
  const data = rows.map((r) => {
    const rec: Record<string, string | number | null> = { [xName]: cellText(r[xi]) }
    ys.forEach((n, k) => (rec[n] = toNum(r[idx[k]])))
    return rec
  })
  return { x: xName, y: ys, data }
}

/** Pie slices; past `max` slices the smallest fold into "Other" so colors never repeat. */
export function pieData(columns: Pick<ResultColumn, 'name'>[], rows: unknown[][], label?: string, value?: string, max = 6): { name: string; value: number; other?: boolean }[] {
  const { x, y, data } = chartData(columns, rows, label, value ? [value] : undefined)
  const v = y[0]
  const all = data.map((d) => ({ name: String(d[x]), value: Number(d[v] ?? 0) })).filter((d) => d.value > 0)
  if (all.length <= max) return all
  const keep = [...all].sort((a, b) => b.value - a.value).slice(0, max - 1)
  const rest = all.filter((d) => !keep.includes(d)).reduce((s, d) => s + d.value, 0)
  return [...all.filter((d) => keep.includes(d)), { name: 'Other', value: rest, other: true }]
}

/** Validate an imported board file. Throws on anything that is not a board. */
export function parseBoardFile(text: string): { name: string; board: Board } {
  const j = JSON.parse(text) as { name?: unknown; board?: Board }
  const b = j?.board
  if (!b || !Array.isArray(b.objects)) throw new Error('This file is not a metrics board export.')
  const objects = b.objects.filter((o) => o && typeof o.id === 'string' && o.type in OBJ_LABELS && o.frame && [o.frame.x, o.frame.y, o.frame.w, o.frame.h].every((n) => typeof n === 'number'))
  const ids = new Set(objects.map((o) => o.id))
  const links = (Array.isArray(b.links) ? b.links : []).filter((l) => ids.has(l?.from) && ids.has(l?.to))
  return { name: typeof j.name === 'string' && j.name.trim() ? j.name.trim() : 'Imported board', board: { objects, links, locked: !!b.locked, grid: b.grid !== false } }
}

/** Board most recently saved by the app (boards carry updatedAt in their JSON). */
export const latestBoard = (list: BoardRow[]): BoardRow | undefined =>
  list.reduce<BoardRow | undefined>((best, b) => (!best || (b.board?.updatedAt ?? 0) > (best.board?.updatedAt ?? 0) ? b : best), undefined)

/** Called by the SQL editor's chart view: append to the most recently edited board (or create one) and open the Metrics tab. */
export async function addToMetricsBoard(obj: { type: 'bar' | 'line' | 'pie' | 'table' | 'scoreboard'; label: string; query: string; x?: string; y?: string[] }): Promise<void> {
  // dynamic imports: api/ws touch `window` at load time, which would break the node tests of the helpers above
  const [{ call, toast }, { openTab }] = await Promise.all([import('./api'), import('./ws')])
  const list = await call<BoardRow[]>('metrics.list')
  const target = latestBoard(list)
  const board: Board = target?.board?.objects ? target.board : { objects: [], links: [], grid: true }
  const o = { ...newObject(obj.type, crypto.randomUUID(), board.objects), label: obj.label, query: obj.query, x: obj.x, y: obj.y }
  await call('metrics.save', { id: target?.id, name: target?.name ?? 'Board 1', connectionId: target?.connectionId ?? null, board: { ...board, objects: [...board.objects, o], updatedAt: Date.now() } })
  toast(`Added to ${target?.name ?? 'Board 1'}`, 'success')
  openTab({ kind: 'metrics', title: 'Metrics' })
  window.dispatchEvent(new CustomEvent('metrics:changed'))
}
