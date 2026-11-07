import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyParams } from '../src/shared/split.ts'
import { chartData, pieData, toNum, newObject, parseBoardFile, latestBoard, snap } from '../src/renderer/src/lib/metrics.ts'
import type { BoardRow } from '../src/renderer/src/lib/metrics.ts'

test('$var substitution is plain text, also inside quotes, unknown names untouched', () => {
  const v = { input: 'paid', n: '5' }
  assert.equal(applyParams("select * from o where status = '$input' limit $n", 'dollar', v, true), "select * from o where status = 'paid' limit 5")
  assert.equal(applyParams('select $1, $other, $$x$$', 'dollar', v, true), 'select $1, $other, $$x$$')
})

test('numeric coercion', () => {
  assert.equal(toNum('12.5'), 12.5)
  assert.equal(toNum(' -3 '), -3)
  assert.equal(toNum('1e3'), 1000)
  assert.equal(toNum('12abc'), null)
  assert.equal(toNum(null), null)
  assert.equal(toNum(''), null)
})

test('chartData defaults x to first column and y to numeric columns', () => {
  const cols = [{ name: 'month' }, { name: 'revenue' }, { name: 'note' }, { name: 'orders' }]
  const rows = [['2026-01', '100.5', 'a', 3], ['2026-02', null, 'b', '4']]
  const d = chartData(cols, rows)
  assert.equal(d.x, 'month')
  assert.deepEqual(d.y, ['revenue', 'orders'])
  assert.deepEqual(d.data[0], { month: '2026-01', revenue: 100.5, orders: 3 })
  assert.equal(d.data[1].revenue, null)
  assert.deepEqual(chartData(cols, rows, 'note', ['orders', 'missing']).y, ['orders'])
})

test('pieData folds the smallest slices into Other', () => {
  const rows = [['a', 50], ['b', 5], ['c', 30], ['d', 1], ['e', 20], ['f', 2]]
  const p = pieData([{ name: 'k' }, { name: 'v' }], rows, undefined, undefined, 4)
  assert.deepEqual(p.map((s) => s.name), ['a', 'c', 'e', 'Other'])
  assert.equal(p[3].value, 8)
  assert.equal(pieData([{ name: 'k' }, { name: 'v' }], rows.slice(0, 3)).length, 3)
})

test('new objects snap to the grid and stack below existing ones', () => {
  assert.equal(snap(13), 16)
  assert.equal(snap(-5), 0)
  const a = newObject('bar', 'a', [])
  assert.deepEqual([a.frame.x, a.frame.y], [16, 16])
  const b = newObject('input', 'b', [a])
  assert.equal(b.frame.y, snap(a.frame.y + a.frame.h + 16))
  assert.equal(b.varName, 'input')
  assert.deepEqual(newObject('table', 'c', [a], { x: 101, y: 203 }).frame.x, 104)
})

test('board import validation drops broken objects and dangling links', () => {
  const file = JSON.stringify({ name: ' Sales ', board: { objects: [{ id: 'a', type: 'bar', label: 'x', frame: { x: 0, y: 0, w: 10, h: 10 } }, { id: 'b', type: 'evil', frame: {} }], links: [{ from: 'a', to: 'b' }] } })
  const r = parseBoardFile(file)
  assert.equal(r.name, 'Sales')
  assert.equal(r.board.objects.length, 1)
  assert.equal(r.board.links.length, 0)
  assert.throws(() => parseBoardFile('{"foo":1}'))
  assert.throws(() => parseBoardFile('not json'))
})

test('latestBoard picks the most recently saved board', () => {
  const row = (id: string, updatedAt?: number): BoardRow => ({ id, name: id, connectionId: null, board: { objects: [], links: [], updatedAt } })
  assert.equal(latestBoard([row('a', 1), row('b', 5), row('c')])?.id, 'b')
  assert.equal(latestBoard([]), undefined)
})
