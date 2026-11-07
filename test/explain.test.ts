// Plan parsing against real EXPLAIN output captured from PostgreSQL 17, MySQL (JSON v1/v2, tree, table) and SQLite.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parsePlan, planStats, planText, explainSql, walkPlan, type PlanNode } from '../src/shared/explain.ts'

const fx = JSON.parse(readFileSync(new URL('./explain.fixtures.json', import.meta.url), 'utf8'))
const one = (text: string): unknown[][] => [[text]]
const nodes = (root: PlanNode): PlanNode[] => { const out: PlanNode[] = []; walkPlan(root, (n) => out.push(n)); return out }

test('explain statement per dialect', () => {
  assert.equal(explainSql('postgres', 'select 1;'), 'EXPLAIN (FORMAT JSON) select 1')
  assert.equal(explainSql('postgres', 'select 1', true), 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) select 1')
  assert.equal(explainSql('mysql', 'select 1', true), 'EXPLAIN ANALYZE FORMAT=JSON select 1')
  assert.equal(explainSql('mysql', 'select 1', true, true), 'ANALYZE FORMAT=JSON select 1')
  assert.equal(explainSql('sqlite', 'select 1'), 'EXPLAIN QUERY PLAN select 1')
})

test('PostgreSQL JSON: tree, costs, self share', () => {
  const p = parsePlan('postgres', ['QUERY PLAN'], one(fx.pg))
  assert.equal(p.metric, 'cost')
  assert.equal(p.total, 131.04)
  assert.equal(p.root.op, 'Sort')
  const all = nodes(p.root)
  assert.deepEqual(all.map((n) => n.kind), ['Sort', 'Aggregate', 'Hash Join', 'Seq Scan', 'Hash', 'Seq Scan'])
  const scan = all.find((n) => n.relation === 'orders')!
  assert.equal(scan.filter, "(total > '10'::numeric)")
  assert.equal(scan.rows, 1960)
  assert.equal(all[1].op, 'Aggregate (Hashed)')
  // exclusive shares add up to the whole
  assert.ok(Math.abs(all.reduce((a, n) => a + n.pctOfTotal, 0) - 100) < 1e-6)
  assert.ok(Math.abs(scan.pctOfTotal - (46 / 131.04) * 100) < 1e-6)
})

test('PostgreSQL ANALYZE: time metric, loops, planning/execution', () => {
  const p = parsePlan('postgres', ['QUERY PLAN'], one(fx.pgAnalyze))
  assert.equal(p.metric, 'time')
  assert.equal(p.executionTime, 1.082)
  assert.equal(p.planningTime, 0.437)
  assert.equal(p.root.actualRows, 750)
  assert.equal(p.root.props['Sort Method'], 'quicksort')
  assert.ok(p.root.children[0].pctOfTotal > 0)
})

test('MySQL JSON v2 (iterator tree), incl. subqueries and ANALYZE', () => {
  const p = parsePlan('mysql', ['EXPLAIN'], one(fx.myV2))
  assert.equal(p.format, 'MySQL JSON v2')
  assert.equal(p.root.op, 'Sort: count(*) DESC')
  assert.equal(p.total, 3.652073732718894) // root has no cost: sum of children
  const all = nodes(p.root)
  assert.equal(all.length, 7)
  const lookup = all.find((n) => n.relation === 'ord')!
  assert.equal(lookup.index, 'cust_id')
  assert.equal(lookup.kind, 'index_lookup')
  assert.equal(lookup.filter, 'cust_id = c.id')

  const sub = nodes(parsePlan('mysql', ['EXPLAIN'], one(fx.myV2Sub)).root)
  assert.ok(sub.some((n) => n.op.startsWith('Aggregate: max')), 'select-list subquery is a child')

  const a = parsePlan('mysql', ['EXPLAIN'], one(fx.myV2Analyze))
  assert.equal(a.metric, 'time')
  assert.ok(nodes(a.root).every((n) => n.actualTime !== undefined || n.children.length))
})

test('MySQL JSON v1 (query_block)', () => {
  const p = parsePlan('mysql', ['EXPLAIN'], one(fx.myV1))
  assert.equal(p.root.op, 'Query block #1')
  const tables = nodes(p.root).filter((n) => n.relation)
  assert.deepEqual(tables.map((t) => [t.relation, t.kind, t.index]), [['c', 'index', 'city'], ['o', 'ref', 'cust_id']])
  assert.equal(tables[1].cost, 1.75)
  assert.equal(p.total, 2.5)
  assert.equal(p.root.props['cost_info.query_cost'], '2.50')
})

test('MySQL tree text (EXPLAIN ANALYZE) and tabular EXPLAIN', () => {
  const t = parsePlan('mysql', ['EXPLAIN'], one(fx.myTreeAnalyze))
  const all = nodes(t.root)
  assert.equal(all.length, 7)
  assert.equal(t.metric, 'time')
  const lookup = all[all.length - 1]
  assert.equal(lookup.loops, 5)
  assert.equal(lookup.relation, 'o')
  assert.equal(lookup.index, 'cust_id')
  assert.equal(all[3].children.length, 2)

  const tab = parsePlan('mysql', fx.myTable.columns, fx.myTable.rows)
  assert.equal(tab.metric, 'none')
  assert.deepEqual(tab.root.children.map((n) => [n.op, n.relation, n.rows]), [['Full index scan', 'c', 5], ['Index lookup', 'o', 1]])
})

test('SQLite query plan tree from id/parent', () => {
  const p = parsePlan('sqlite', fx.sqlite.columns, fx.sqlite.rows)
  assert.equal(p.root.children.length, 5)
  const list = p.root.children[1]
  assert.equal(list.kind, 'LIST SUBQUERY')
  assert.equal(list.children[0].relation, 'b')
  assert.equal(p.root.children[2].index, 'b_a')
})

test('stats and text export', () => {
  const p = parsePlan('postgres', ['QUERY PLAN'], one(fx.pg))
  const s = planStats(p)
  const seq = s.byType.find((x) => x.key === 'Seq Scan')!
  assert.equal(seq.count, 2)
  assert.deepEqual(s.byRelation.map((x) => x.key).sort(), ['customers', 'orders'])
  const txt = planText(p)
  assert.match(txt, /^PostgreSQL JSON · total cost 131/)
  assert.match(txt, /\n {9}-> Seq Scan on orders {2}\(cost=46 rows=1,960\) {2}\[35\.1%\]\n {14}\(total > '10'::numeric\)/)
})
