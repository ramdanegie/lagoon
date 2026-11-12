import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register('data:text/javascript,' + encodeURIComponent(
  'export async function resolve(s, c, next) { try { return await next(s, c) } catch (e) { if (s.startsWith(".") && !s.endsWith(".ts")) return next(s + ".ts", c); throw e } }'
))
const { buildSelect, emptyModel, nextAlias } = await import('../src/shared/querybuilder.ts')

const t = (name: string, alias = name) => ({ alias, schema: 'public', name, x: 0, y: 0 })

test('one table, no columns picked: SELECT *', () => {
  assert.equal(buildSelect('postgres', { ...emptyModel(), tables: [t('users')] }), 'SELECT *\nFROM "public"."users";')
  assert.equal(buildSelect('postgres', emptyModel()), '')
})

test('joins in order, LEFT seen from the other side becomes RIGHT, CROSS JOIN when unlinked', () => {
  const m = {
    ...emptyModel(),
    tables: [t('orders'), t('customers'), t('items'), t('tags')],
    columns: [{ table: 'customers', column: 'name', agg: '' as const, as: '' }, { table: 'orders', column: 'id', agg: 'COUNT' as const, as: 'orders' }],
    joins: [
      { left: 'customers', leftCol: 'id', right: 'orders', rightCol: 'customer_id', kind: 'LEFT' as const },
      { left: 'orders', leftCol: 'id', right: 'items', rightCol: 'order_id', kind: 'INNER' as const }
    ],
    sort: [{ table: 'customers', column: 'name', dir: 'ASC' as const }],
    limit: 50
  }
  assert.equal(buildSelect('postgres', m), [
    'SELECT "customers"."name",',
    '       COUNT("orders"."id") AS "orders"',
    'FROM "public"."orders"',
    'RIGHT OUTER JOIN "public"."customers" ON "customers"."id" = "orders"."customer_id"',
    'INNER JOIN "public"."items" ON "orders"."id" = "items"."order_id"',
    'CROSS JOIN "public"."tags"',
    'GROUP BY "customers"."name"',
    'ORDER BY "customers"."name" ASC',
    'LIMIT 50;'
  ].join('\n'))
})

test('self join with aliases, WHERE values quoted by type, IN lists, NULL checks, OR, DISTINCT, MySQL quoting', () => {
  const m = { ...emptyModel(), tables: [], joins: [], where: [] } as ReturnType<typeof emptyModel>
  m.tables.push(t('emp'))
  const boss = nextAlias(m, 'emp')
  assert.equal(boss, 'emp_2')
  m.tables.push(t('emp', boss))
  m.joins.push({ left: 'emp', leftCol: 'manager_id', right: boss, rightCol: 'id', kind: 'INNER' })
  m.columns = [{ table: 'emp', column: 'name', agg: '', as: '' }, { table: boss, column: 'name', agg: '', as: 'boss' }]
  m.where = [
    { table: 'emp', column: 'salary', type: 'integer', op: '>=', value: ' 5000 ' },
    { table: 'emp', column: 'name', type: 'text', op: 'LIKE', value: "O'B%" },
    { table: 'emp', column: 'dept', type: 'text', op: 'IN', value: 'a, b' },
    { table: 'emp', column: 'left_at', type: 'date', op: 'IS NULL', value: 'ignored' }
  ]
  m.whereJoin = 'OR'
  m.distinct = true
  const sql = buildSelect('mysql', { ...m, tables: m.tables.map((x) => ({ ...x, schema: 'hr' })) })
  assert.match(sql, /^SELECT DISTINCT `emp`\.`name`,\n {7}`emp_2`\.`name` AS `boss`\nFROM `hr`\.`emp`\nINNER JOIN `hr`\.`emp` AS `emp_2` ON `emp`\.`manager_id` = `emp_2`\.`id`\n/)
  assert.match(sql, /WHERE `emp`\.`salary` >= 5000\n {2}OR `emp`\.`name` LIKE 'O''B%'\n {2}OR `emp`\.`dept` IN \('a', 'b'\)\n {2}OR `emp`\.`left_at` IS NULL;$/)
  assert.doesNotMatch(sql, /GROUP BY/)
})
