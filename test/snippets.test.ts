import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allSnippets, identAt, tablesInQuery, tableOf, aliasFor, joinSuggestions, BUILTIN_SNIPPETS } from '../src/renderer/src/lib/snippets.ts'
import type { ForeignKey } from '../src/shared/types.ts'

test('snippets filter by dialect, user ones included', () => {
  const user = [{ id: 'u1', name: 'Mine', prefix: 'mine', body: 'SELECT 1', dialects: ['mysql'] }]
  const pg = allSnippets(user, 'postgres')
  assert.ok(pg.some((s) => s.body.includes('ON CONFLICT')))
  assert.ok(!pg.some((s) => s.body.includes('ON DUPLICATE KEY')))
  assert.ok(!pg.some((s) => s.id === 'u1'))
  assert.ok(allSnippets(user, 'mysql').some((s) => s.id === 'u1'))
  assert.equal(allSnippets(user).length, BUILTIN_SNIPPETS.length + 1)
  for (const s of BUILTIN_SNIPPETS) assert.match(s.prefix, /^[\w$]+$/)
})

test('identifier under the caret', () => {
  const line = 'select o.total from public."Orders" o'
  assert.deepEqual(identAt(line, line.indexOf('total') + 2), { from: 9, to: 14, parts: ['o', 'total'], part: 1 })
  const q = identAt(line, line.indexOf('Orders'))!
  assert.deepEqual([q.parts, q.part], [['public', 'Orders'], 1])
  assert.equal(identAt('limit 100', 7), null)
})

test('tables in scope and alias resolution', () => {
  const sql = "SELECT * FROM orders o LEFT JOIN public.customers AS c ON c.id = o.customer_id JOIN items WHERE x = 'from y'"
  assert.deepEqual(tablesInQuery(sql), [{ name: 'orders', alias: 'o' }, { schema: 'public', name: 'customers', alias: 'c' }, { name: 'items', alias: undefined }])
  const scope = tablesInQuery(sql)
  assert.deepEqual(tableOf({ from: 0, to: 0, parts: ['o'], part: 0 }, scope), { schema: undefined, name: 'orders' })
  assert.deepEqual(tableOf({ from: 0, to: 0, parts: ['o', 'total'], part: 0 }, scope), { schema: undefined, name: 'orders' })
  assert.equal(tableOf({ from: 0, to: 0, parts: ['o', 'total'], part: 1 }, scope), null)
  assert.deepEqual(tableOf({ from: 0, to: 0, parts: ['sales', 'orders'], part: 1 }, scope), { schema: 'sales', name: 'orders' })
})

test('JOIN suggestions from foreign keys both ways', () => {
  const fk = (columns: string[], refTable: string, refColumns: string[]): ForeignKey => ({ name: 'f', columns, refSchema: 'public', refTable, refColumns, onUpdate: '', onDelete: '' })
  const fks = new Map<string, ForeignKey[]>([
    ['orders', [fk(['customer_id'], 'customers', ['id'])]],
    ['order_items', [fk(['order_id'], 'orders', ['id'])]],
    ['customers', []]
  ])
  assert.deepEqual(joinSuggestions(tablesInQuery('select * from orders o join '), fks, 'public'), [
    'customers c ON c.id = o.customer_id',
    'order_items oi ON oi.order_id = o.id'
  ])
  assert.deepEqual(joinSuggestions(tablesInQuery('select * from customers join '), fks, 'public'), ['orders o ON o.customer_id = customers.id'])
  assert.equal(aliasFor('customers', ['c', 'C2']), 'c3')
})
