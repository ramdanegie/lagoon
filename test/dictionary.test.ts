import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dictHtml, dictMarkdown, nameMatcher, anchor, type Dict } from '../src/shared/dictionary.ts'
import type { Column } from '../src/shared/types.ts'

const col = (name: string, type: string, o: Record<string, unknown> = {}): Column => ({ name, type, nullable: true, default: null, pk: false, ordinal: 1, comment: null, ...o })
const dict: Dict = {
  connection: 'local', database: 'shop', schema: 'public', dialect: 'postgres', generatedAt: '2026-01-02T03:04:05.000Z',
  tables: [
    { name: 'customers', kind: 'table', comment: 'People who <buy>', rows: 1200, columns: [col('id', 'integer', { pk: true, nullable: false, default: "nextval('c')" }), col('email', 'text', { comment: 'a|b' })], indexes: [{ name: 'customers_pkey', columns: ['id'], unique: true, primary: true, type: 'btree' }], fks: [] },
    { name: 'orders', kind: 'table', comment: null, rows: null, columns: [col('id', 'integer', { pk: true }), col('customer_id', 'integer')], indexes: [], fks: [{ name: 'orders_customer_fk', columns: ['customer_id'], refSchema: 'public', refTable: 'customers', refColumns: ['id'], onUpdate: 'NO ACTION', onDelete: 'CASCADE' }] }
  ],
  views: [{ name: 'big_orders', kind: 'view', comment: null, rows: null, columns: [col('id', 'integer')], indexes: [], fks: [], definition: 'CREATE VIEW big_orders AS SELECT 1 < 2' }],
  routines: [{ name: 'add', kind: 'function', signature: 'add(a integer, b integer) → integer' }]
}

test('dictMarkdown: contents, columns with keys, escaped pipes, view definitions, routines', () => {
  const md = dictMarkdown(dict)
  assert.match(md, /^# Data dictionary: shop · public/)
  assert.match(md, /- \[orders\]\(#table-orders\)/)
  assert.match(md, /\| customer_id \| integer \| YES \| {2}\| FK → customers\.id \| {2}\|/)
  assert.match(md, /\| email \| text \| YES \| {2}\| {2}\| a\\\|b \|/)
  assert.match(md, /~1,200 rows/)
  assert.match(md, /```sql\nCREATE VIEW big_orders AS SELECT 1 < 2\n```/)
  assert.match(md, /\| function \| add\(a integer, b integer\) → integer \|/)
})

test('dictHtml: self-contained, escaped, linked table of contents and FK targets', () => {
  const html = dictHtml(dict)
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /<style>/)
  assert.doesNotMatch(html, /<link |<script/)
  assert.match(html, /People who &lt;buy&gt;/)
  assert.match(html, /SELECT 1 &lt; 2/)
  assert.match(html, /<nav[^>]*>.*href="#table-customers"/s)
  assert.match(html, /FK → <a href="#table-customers">customers<\/a>\.id/)
  assert.equal(anchor('table', 'Order Items'), 'table-order-items')
})

test('nameMatcher: contains, whole word, prefix, regex, case', () => {
  const names = ['customer_id', 'customers', 'order_customer', 'Customer', 'id']
  const run = (t: string, m: 'contains' | 'word' | 'prefix' | 'regex', c = false): string[] => names.filter(nameMatcher(t, m, c))
  assert.deepEqual(run('customer', 'contains'), ['customer_id', 'customers', 'order_customer', 'Customer'])
  assert.deepEqual(run('customer', 'contains', true), ['customer_id', 'customers', 'order_customer'])
  assert.deepEqual(run('customer', 'prefix'), ['customer_id', 'customers', 'Customer'])
  assert.deepEqual(run('id', 'word'), ['id'])
  assert.deepEqual(nameMatcher('id', 'word', false)('SELECT id FROM t') && nameMatcher('id', 'word', false)('a.id'), true)
  assert.deepEqual(run('^c.*s$', 'regex'), ['customers'])
  assert.deepEqual(run('a.b', 'contains'), [])
  assert.throws(() => nameMatcher('(', 'regex', false))
})
