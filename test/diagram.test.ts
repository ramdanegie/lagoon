import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoLayout, fkGroups, mergeLayout, edgesOf, fkPath, BOX_W, boxHeight } from '../src/renderer/src/lib/diagram.ts'
import type { DTable } from '../src/renderer/src/lib/diagram.ts'

const fk = (refTable: string, refSchema = 'public') => ({ name: `fk_${refTable}`, columns: ['x'], refSchema, refTable, refColumns: ['id'], onUpdate: 'NO ACTION', onDelete: 'NO ACTION' })
const t = (name: string, fks: ReturnType<typeof fk>[] = [], cols = 2): DTable => ({ name, fks, columns: Array.from({ length: cols }, (_, i) => ({ name: `c${i}`, type: 'int', nullable: true, default: null, pk: i === 0, ordinal: i })) })

test('FK grouping: connected tables share a group, unlinked tables get none, other schemas ignored', () => {
  const tables = [t('orders', [fk('customers')]), t('customers'), t('items', [fk('orders')]), t('tags'), t('posts', [fk('users')]), t('users'), t('audit', [fk('x', 'other')])]
  const g = fkGroups(tables.map((x) => x.name), edgesOf(tables, 'public'))
  assert.equal(g.orders, g.customers)
  assert.equal(g.items, g.orders)
  assert.equal(g.posts, g.users)
  assert.notEqual(g.posts, g.orders)
  assert.equal(g.tags, undefined)
  assert.equal(g.audit, undefined)
})

test('auto layout keeps FK neighbours together, bigger groups first, unlinked last', () => {
  const sizes = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, cols: 2 }))
  const edges: [string, string][] = [['e', 'c'], ['b', 'd']]
  const pos = autoLayout(sizes, edges, 'name')
  const order = Object.entries(pos).sort((x, y) => x[1].y - y[1].y || x[1].x - y[1].x).map(([n]) => n)
  assert.deepEqual(order, ['b', 'd', 'c', 'e', 'a'])
  // 5 tables → 3 per row, no overlaps
  assert.equal(pos.b.y, pos.c.y)
  assert.ok(pos.e.y > pos.b.y)
  assert.ok(pos.d.x - pos.b.x >= BOX_W)
})

test('sort by column count orders unlinked tables by size', () => {
  const pos = autoLayout([{ name: 'small', cols: 1 }, { name: 'big', cols: 20 }, { name: 'mid', cols: 5 }], [], 'columns')
  const order = Object.entries(pos).sort((x, y) => x[1].y - y[1].y || x[1].x - y[1].x).map(([n]) => n)
  assert.deepEqual(order, ['big', 'mid', 'small'])
  const tall = autoLayout([{ name: 'a', cols: 30 }, { name: 'b', cols: 1 }, { name: 'c', cols: 1 }], [], 'name')
  assert.ok(tall.c.y >= tall.a.y + boxHeight(30), 'next row starts below the tallest box')
})

test('mergeLayout keeps saved positions and places new tables below them', () => {
  const sizes = [{ name: 'a', cols: 2 }, { name: 'b', cols: 2 }]
  const m = mergeLayout(sizes, [], 'name', { a: { x: 500, y: 300 } })
  assert.deepEqual(m.a, { x: 500, y: 300 })
  assert.ok(m.b.y > 300 + boxHeight(2))
  assert.deepEqual(mergeLayout(sizes, [], 'name', undefined), autoLayout(sizes, [], 'name'))
})

test('fk path leaves from the facing side', () => {
  const right = fkPath({ x: 0, y: 0 }, 0, { x: 500, y: 0 }, 1, false)
  assert.ok(right.d.startsWith(`M${BOX_W},`))
  assert.equal(right.end.x, 500)
  const left = fkPath({ x: 500, y: 0 }, 0, { x: 0, y: 0 }, 0, false)
  assert.ok(left.d.startsWith('M500,'))
  assert.equal(left.end.x, BOX_W)
})
