// Execution plans: build the EXPLAIN statement per dialect and parse what comes back into one node tree.
// Handles PostgreSQL JSON, MySQL JSON (v1 query_block / MariaDB, v2 iterator tree), MySQL TREE text and
// tabular EXPLAIN, and SQLite EXPLAIN QUERY PLAN. Pure (type-only imports) so `node --test` can load it.
import type { Dialect } from './types'

export interface PlanNode {
  op: string // display label
  kind: string // node type, used for the per-type stats
  relation?: string
  index?: string
  rows?: number // planner estimate
  actualRows?: number // total over all loops
  cost?: number // cumulative (node + children), as the planner reports it
  actualTime?: number // ms, cumulative, total over all loops
  loops?: number
  filter?: string
  self: number // exclusive cost (or time when analyzed)
  pctOfTotal: number // self / plan total * 100
  props: Record<string, unknown> // every raw property, for the details panel
  children: PlanNode[]
}

export interface Plan {
  root: PlanNode
  metric: 'time' | 'cost' | 'none'
  total: number
  format: string
  raw: string
  planningTime?: number
  executionTime?: number
}

type Obj = Record<string, unknown>
type Draft = Omit<PlanNode, 'self' | 'pctOfTotal' | 'children'> & { children: Draft[] }

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
const str = (v: unknown): string | undefined => (v === null || v === undefined || v === '' ? undefined : String(v))
const times = (a: number | undefined, loops: number | undefined): number | undefined => (a === undefined ? undefined : a * (loops ?? 1))
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

/** The statement to send. `analyze` executes the query (PG, MySQL 8.0.18+, MariaDB). */
export function explainSql(dialect: Dialect, sql: string, analyze = false, mariadb = false): string {
  const body = sql.trim().replace(/;\s*$/, '')
  if (dialect === 'sqlite') return `EXPLAIN QUERY PLAN ${body}`
  if (dialect === 'mysql') return `${analyze ? (mariadb ? 'ANALYZE' : 'EXPLAIN ANALYZE') : 'EXPLAIN'} FORMAT=JSON ${body}`
  return `EXPLAIN (${analyze ? 'ANALYZE, BUFFERS, ' : ''}FORMAT JSON) ${body}`
}

/** Older servers without FORMAT=JSON: tabular EXPLAIN, or TREE text for EXPLAIN ANALYZE. */
export const explainFallbackSql = (sql: string, analyze = false): string => `${analyze ? 'EXPLAIN ANALYZE' : 'EXPLAIN'} ${sql.trim().replace(/;\s*$/, '')}`

/** Parse an EXPLAIN result (column names + rows as the query RPC returns them). */
export function parsePlan(dialect: Dialect, columns: string[], rows: unknown[][]): Plan {
  if (dialect === 'sqlite' || (columns.includes('parent') && columns.includes('detail'))) return sqlitePlan(columns, rows)
  if (columns.length === 1) {
    const text = rows.map((r) => String(r[0] ?? '')).join('\n').trim()
    if (text.startsWith('[') || text.startsWith('{')) return jsonPlan(text)
    if (text.startsWith('->')) return treePlan(text)
  }
  if (columns.includes('select_type')) return mysqlTablePlan(columns, rows)
  throw new Error('Unrecognised plan format')
}

// ---------- JSON ----------
export function jsonPlan(text: string): Plan {
  const doc = JSON.parse(text) as unknown
  const top = (Array.isArray(doc) ? doc[0] : doc) as Obj
  const raw = JSON.stringify(doc, null, 2)
  if (isObj(top?.Plan)) {
    return finish(pgNode(top.Plan), 'PostgreSQL JSON', raw, { planningTime: num(top['Planning Time']), executionTime: num(top['Execution Time']) })
  }
  if (isObj(top?.query_plan)) return finish(myV2Node(top.query_plan), 'MySQL JSON v2', raw)
  if (isObj(top?.query_block)) return finish(myV1Node('query_block', top.query_block), 'MySQL JSON', raw)
  throw new Error('Unrecognised JSON plan')
}

const PG_COND = ['Filter', 'Index Cond', 'Hash Cond', 'Merge Cond', 'Join Filter', 'Recheck Cond', 'TID Cond']

function pgNode(p: Obj): Draft {
  const { Plans, ...props } = p
  const type = String(p['Node Type'] ?? 'Node')
  const qual = [p.Strategy !== 'Plain' && p.Strategy, p['Join Type'] !== 'Inner' && p['Join Type'], p['Scan Direction'] === 'Backward' && 'Backward'].filter(Boolean)
  const loops = num(p['Actual Loops'])
  return {
    op: qual.length ? `${type} (${qual.join(', ')})` : type,
    kind: type,
    relation: str(p['Relation Name'] ?? p['CTE Name'] ?? p['Function Name']),
    index: str(p['Index Name']),
    rows: num(p['Plan Rows']),
    actualRows: times(num(p['Actual Rows']), loops),
    cost: num(p['Total Cost']),
    actualTime: times(num(p['Actual Total Time']), loops),
    loops,
    filter: str(PG_COND.map((k) => p[k]).find((v) => v !== undefined)),
    props,
    children: Array.isArray(Plans) ? (Plans as Obj[]).map(pgNode) : []
  }
}

function myV2Node(p: Obj): Draft {
  const props: Obj = {}
  const children: Draft[] = []
  // child iterators live in `inputs`, `inputs_from_select_list`, … : any array of objects with an operation
  for (const [k, v] of Object.entries(p)) {
    if (Array.isArray(v) && v.length && v.every((x) => isObj(x) && 'operation' in x)) children.push(...(v as Obj[]).map(myV2Node))
    else props[k] = v
  }
  const loops = num(p.actual_loops)
  return {
    op: String(p.operation ?? p.access_type ?? 'Operation'),
    kind: String(p.index_access_type ?? p.access_type ?? p.operation ?? 'operation'),
    relation: str(p.table_name),
    index: str(p.index_name),
    rows: num(p.estimated_rows),
    actualRows: times(num(p.actual_rows), loops),
    cost: num(p.estimated_total_cost),
    actualTime: times(num(p.actual_last_row_ms), loops),
    loops,
    filter: str(p.condition ?? p.lookup_condition ?? p.hash_condition),
    props,
    children
  }
}

const ACCESS: Record<string, string> = {
  ALL: 'Full table scan', index: 'Full index scan', range: 'Index range scan', ref: 'Index lookup', eq_ref: 'Unique index lookup',
  const: 'Single row (const)', system: 'Single row (system)', ref_or_null: 'Index lookup or NULL', index_merge: 'Index merge',
  fulltext: 'Fulltext index', unique_subquery: 'Unique subquery lookup', index_subquery: 'Subquery index lookup'
}
const human = (k: string): string => (k.charAt(0).toUpperCase() + k.slice(1)).replace(/_/g, ' ')

/** v1 / MariaDB: nested named objects; `table` entries are the scans, everything else is an operation wrapper. */
function myV1Node(name: string, o: Obj): Draft {
  const props: Obj = {}
  const children: Draft[] = []
  for (const [k, v] of Object.entries(o)) {
    if (isObj(v) && k !== 'cost_info' && !k.endsWith('_info')) children.push(myV1Node(k, v))
    else if (Array.isArray(v) && v.some(isObj)) {
      for (const it of v as Obj[]) {
        const keys = Object.keys(it)
        children.push(keys.length === 1 && isObj(it[keys[0]]) ? myV1Node(keys[0], it[keys[0]] as Obj) : myV1Node(k, it))
      }
    } else props[k] = v
  }
  const ci = isObj(o.cost_info) ? o.cost_info : {}
  if (isObj(o.cost_info)) Object.assign(props, Object.fromEntries(Object.entries(ci).map(([k, v]) => [`cost_info.${k}`, v])))
  const childCost = children.reduce((a, c) => a + (c.cost ?? 0), 0)
  if (name === 'table') {
    const access = String(o.access_type ?? '')
    const self = num(ci.read_cost) !== undefined ? (num(ci.read_cost) ?? 0) + (num(ci.eval_cost) ?? 0) : num(o.cost) // MariaDB: `cost`
    const loops = num(o.r_loops)
    return {
      op: ACCESS[access] ?? (access || 'Table'),
      kind: access || 'table',
      relation: str(o.table_name),
      index: str(o.key),
      rows: num(o.rows_examined_per_scan ?? o.rows),
      actualRows: times(num(o.r_rows), loops),
      cost: self === undefined ? undefined : self + childCost,
      actualTime: num(o.r_total_time_ms),
      loops,
      filter: str(o.attached_condition),
      props,
      children
    }
  }
  const op = name === 'query_block' ? `Query block #${o.select_id ?? 1}` : human(name)
  return { op, kind: name, props, children, actualTime: num(o.r_total_time_ms) }
}

// ---------- MySQL TREE text (FORMAT=TREE, EXPLAIN ANALYZE) ----------
const TREE_LINE = /^(\s*)-> (.*?)(?:\s+\(cost=([\d.e+-]+)(?:\.\.([\d.e+-]+))? rows=([\d.e+-]+)\))?(?:\s+\(actual time=([\d.e+-]+)\.\.([\d.e+-]+) rows=([\d.e+-]+) loops=(\d+)\))?(?:\s+\(never executed\))?\s*$/

export function treePlan(text: string): Plan {
  const stack: { depth: number; node: Draft }[] = []
  let root: Draft | undefined
  for (const line of text.split('\n')) {
    const m = TREE_LINE.exec(line)
    if (!m) continue
    const [, ind, op, c1, c2, rows, , last, arows, loops] = m
    const l = num(loops)
    const node: Draft = {
      op,
      kind: op.replace(/(:| on | using ).*$/, '').trim(),
      relation: /\bon (\S+)/.exec(op)?.[1],
      index: / using (\S+)/.exec(op)?.[1],
      rows: num(rows),
      cost: num(c2 ?? c1),
      actualRows: times(num(arows), l),
      actualTime: times(num(last), l),
      loops: l,
      filter: /^Filter: (.*)$/.exec(op)?.[1],
      props: { operation: op, cost: c2 ?? c1, rows, actual_time_last_row: last, actual_rows: arows, loops },
      children: []
    }
    const depth = ind.length
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop()
    if (stack.length) stack[stack.length - 1].node.children.push(node)
    else if (!root) root = node
    stack.push({ depth, node })
  }
  if (!root) throw new Error('Unrecognised plan text')
  return finish(root, 'MySQL tree', text)
}

// ---------- MySQL tabular EXPLAIN ----------
export function mysqlTablePlan(columns: string[], rows: unknown[][]): Plan {
  const at = (r: unknown[], c: string): unknown => r[columns.indexOf(c)]
  const selects = new Map<string, Draft>()
  for (const r of rows) {
    const id = String(at(r, 'id') ?? '')
    if (!selects.has(id)) selects.set(id, { op: `Select #${id || '?'} (${at(r, 'select_type') ?? ''})`, kind: String(at(r, 'select_type') ?? 'SELECT'), props: { id, select_type: at(r, 'select_type') }, children: [] })
    const type = String(at(r, 'type') ?? '')
    selects.get(id)!.children.push({
      op: ACCESS[type] ?? (type || 'Step'),
      kind: type || 'step',
      relation: str(at(r, 'table')),
      index: str(at(r, 'key')),
      rows: num(at(r, 'rows')),
      filter: str(at(r, 'Extra')),
      props: Object.fromEntries(columns.map((c, i) => [c, r[i]])),
      children: []
    })
  }
  const list = [...selects.values()]
  const root = list.length === 1 ? list[0] : { op: 'Query', kind: 'query', props: {}, children: list }
  return finish(root, 'MySQL table', [columns.join('\t'), ...rows.map((r) => r.map((v) => (v === null ? 'NULL' : String(v))).join('\t'))].join('\n'))
}

// ---------- SQLite EXPLAIN QUERY PLAN ----------
export function sqlitePlan(columns: string[], rows: unknown[][]): Plan {
  const ci = (c: string, d: number): number => (columns.includes(c) ? columns.indexOf(c) : d)
  const [iId, iParent, iDetail] = [ci('id', 0), ci('parent', 1), ci('detail', 3)]
  const root: Draft = { op: 'Query plan', kind: 'QUERY', props: {}, children: [] }
  const byId = new Map<string, Draft>([['0', root]])
  for (const r of rows) {
    const detail = String(r[iDetail] ?? '')
    const scan = /^(SCAN|SEARCH) (?:TABLE )?(\S+)/.exec(detail)
    const ix = /USING (?:COVERING )?INDEX (\S+)|USING (INTEGER PRIMARY KEY)/.exec(detail)
    const node: Draft = {
      op: detail,
      kind: scan ? scan[1] : detail.replace(/\s+\d+$/, ''),
      relation: scan?.[2],
      index: ix ? (ix[1] ?? ix[2]) : undefined,
      filter: /\((.+=.+)\)$/.exec(detail)?.[1],
      props: { id: r[iId], parent: r[iParent], detail },
      children: []
    }
    byId.set(String(r[iId]), node)
    ;(byId.get(String(r[iParent])) ?? root).children.push(node)
  }
  return finish(root.children.length === 1 ? root.children[0] : root, 'SQLite query plan', rows.map((r) => `${r[iId]}\t${r[iParent]}\t${r[iDetail]}`).join('\n'))
}

// ---------- totals, stats, text ----------
function finish(d: Draft, format: string, raw: string, extra: Partial<Plan> = {}): Plan {
  const metric: Plan['metric'] = d.actualTime !== undefined ? 'time' : someCost(d) ? 'cost' : 'none'
  // a node without its own figure (e.g. MySQL's top Sort) counts as the sum of its children
  const value = (n: Draft): number => (metric === 'time' ? n.actualTime : n.cost) ?? n.children.reduce((a, c) => a + value(c), 0)
  const total = metric === 'none' ? 0 : value(d)
  const build = (n: Draft): PlanNode => {
    const self = metric === 'none' ? 0 : Math.max(0, value(n) - n.children.reduce((a, c) => a + value(c), 0))
    return { ...n, self, pctOfTotal: total > 0 ? (self / total) * 100 : 0, children: n.children.map(build) }
  }
  return { root: build(d), metric, total, format, raw, ...extra }
}
const someCost = (n: Draft): boolean => n.cost !== undefined || n.children.some(someCost)

export function walkPlan(n: PlanNode, fn: (n: PlanNode, depth: number) => void, depth = 0): void {
  fn(n, depth)
  for (const c of n.children) walkPlan(c, fn, depth + 1)
}

export interface PlanStat { key: string; count: number; self: number; pct: number; rows: number }

/** Exclusive cost/time and row counts summed per node type and per table, most expensive first. */
export function planStats(plan: Plan): { byType: PlanStat[]; byRelation: PlanStat[] } {
  const group = (keyOf: (n: PlanNode) => string | undefined): PlanStat[] => {
    const m = new Map<string, PlanStat>()
    walkPlan(plan.root, (n) => {
      const key = keyOf(n)
      if (!key) return
      const s = m.get(key) ?? { key, count: 0, self: 0, pct: 0, rows: 0 }
      s.count++
      s.self += n.self
      s.pct += n.pctOfTotal
      s.rows += n.actualRows ?? n.rows ?? 0
      m.set(key, s)
    })
    return [...m.values()].sort((a, b) => b.self - a.self || b.count - a.count || a.key.localeCompare(b.key))
  }
  return { byType: group((n) => n.kind), byRelation: group((n) => n.relation) }
}

export const fmtNum = (n: number | undefined): string => (n === undefined ? '' : Math.abs(n) >= 100 || Number.isInteger(n) ? Math.round(n).toLocaleString('en-US') : String(Number(n.toFixed(2))))

/** One line per node, indented like the tree, for copying or saving. */
export function planText(plan: Plan): string {
  const out: string[] = [`${plan.format}${plan.metric === 'none' ? '' : ` · total ${plan.metric} ${fmtNum(plan.total)}${plan.metric === 'time' ? ' ms' : ''}`}`]
  if (plan.planningTime !== undefined) out.push(`Planning time: ${fmtNum(plan.planningTime)} ms`)
  if (plan.executionTime !== undefined) out.push(`Execution time: ${fmtNum(plan.executionTime)} ms`)
  out.push('')
  walkPlan(plan.root, (n, depth) => {
    const pad = '   '.repeat(depth)
    const where = [n.relation && !n.op.includes(n.relation) ? `on ${n.relation}` : '', n.index && !n.op.includes(n.index) ? `using ${n.index}` : ''].filter(Boolean).join(' ')
    const est = [n.cost !== undefined ? `cost=${fmtNum(n.cost)}` : '', n.rows !== undefined ? `rows=${fmtNum(n.rows)}` : ''].filter(Boolean).join(' ')
    const act = n.actualTime !== undefined ? `actual ${fmtNum(n.actualTime)} ms rows=${fmtNum(n.actualRows)} loops=${n.loops ?? 1}` : ''
    const pct = plan.metric === 'none' ? '' : `${n.pctOfTotal.toFixed(1)}%`
    out.push(`${pad}-> ${[n.op, where].filter(Boolean).join(' ')}${est ? `  (${est})` : ''}${act ? `  (${act})` : ''}${pct ? `  [${pct}]` : ''}`)
    if (n.filter) out.push(`${pad}     ${n.filter}`)
  })
  return out.join('\n')
}
