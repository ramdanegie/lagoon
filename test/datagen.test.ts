import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// datagen.ts imports './sqlgen' without an extension (bundler style); let Node retry with .ts
register('data:text/javascript,' + encodeURIComponent(
  'export async function resolve(s, c, next) { try { return await next(s, c) } catch (e) { if (s.startsWith(".") && !s.endsWith(".ts")) return next(s + ".ts", c); throw e } }'
))
const m = await import('../src/shared/datagen.ts')
type Column = import('../src/shared/types.ts').Column

const col = (name: string, type: string, o: Record<string, unknown> = {}): Column => ({ name, type, nullable: true, default: null, pk: false, ordinal: 1, ...o })

test('rng is deterministic per seed', () => {
  const a = m.rng(42), b = m.rng(42), c = m.rng(43)
  const xs = [a(), a(), a()]
  assert.deepEqual(xs, [b(), b(), b()])
  assert.notDeepEqual(xs, [c(), c(), c()])
  assert.ok(xs.every((x) => x >= 0 && x < 1))
})

test('compilePattern: classes, escapes, quantifiers, groups', () => {
  const r = m.rng(1)
  for (let i = 0; i < 50; i++) {
    assert.match(m.compilePattern('[A-Z]{3}-\\d{4}')(r), /^[A-Z]{3}-\d{4}$/)
    assert.match(m.compilePattern('^(foo|bar)_[a-c0-1]{2,3}x?$')(r), /^(foo|bar)_[a-c01]{2,3}x?$/)
    assert.match(m.compilePattern('\\w+\\.\\d')(r), /^\w{1,5}\.\d$/)
  }
})

test('autoGen picks generators from name, type and keys', () => {
  const g = (c: Column, o = {}, d: 'postgres' | 'mysql' | 'sqlite' = 'postgres'): ReturnType<typeof m.autoGen> => m.autoGen(d, c, o)
  assert.equal(g(col('id', 'integer', { pk: true, default: "nextval('t_id_seq'::regclass)" })).kind, 'skip')
  assert.equal(g(col('id', 'int', { pk: true, extra: 'auto_increment' }), {}, 'mysql').kind, 'skip')
  assert.equal(g(col('id', 'INTEGER', { pk: true }), {}, 'sqlite').kind, 'skip')
  const pk = g(col('code', 'integer', { pk: true }))
  assert.equal(pk.kind, 'int'); assert.equal(pk.unique, true)
  assert.equal(g(col('email', 'character varying(120)'), { unique: true }).kind, 'email')
  assert.equal(g(col('first_name', 'text')).kind, 'firstName')
  assert.equal(g(col('name', 'text')).kind, 'fullName')
  assert.equal(g(col('created_at', 'timestamp without time zone')).kind, 'datetime')
  assert.equal(g(col('born', 'date')).kind, 'date')
  assert.equal(g(col('active', 'boolean')).kind, 'bool')
  assert.equal(g(col('active', 'tinyint(1)'), {}, 'mysql').kind, 'bool')
  assert.deepEqual(g(col('size', "enum('s','m','l')"), {}, 'mysql').values, ['s', 'm', 'l'])
  assert.deepEqual(g(col('status', 'text'), { values: ['a', 'b'] }).values, ['a', 'b'])
  const fk = g(col('parent_id', 'integer'), { ref: { schema: 'public', table: 't', column: 'id' }, self: true })
  assert.equal(fk.kind, 'fk'); assert.equal(fk.nullPct, 50)
  const price = g(col('price', 'numeric(4,2)'))
  assert.equal(price.kind, 'decimal'); assert.equal(price.max, String(99.99)); assert.equal(price.scale, 2)
  assert.equal(g(col('age', 'smallint')).max, '90')
  assert.equal(g(col('sku', 'varchar(20)')).kind, 'pattern')
  assert.equal(g(col('data', 'jsonb')).kind, 'json')
  assert.equal(g(col('blob', 'bytea')).kind, 'skip')
})

test('parseCheckIn: plain, Postgres ANY(ARRAY), MySQL charset prefixes', () => {
  assert.deepEqual(m.parseCheckIn("CHECK (status IN ('new','paid'))"), { column: 'status', values: ['new', 'paid'] })
  assert.deepEqual(m.parseCheckIn("CHECK (((status)::text = ANY ((ARRAY['a'::character varying, 'b''c'::character varying])::text[])))"), { column: 'status', values: ['a', "b'c"] })
  assert.deepEqual(m.parseCheckIn("(`kind` in (_utf8mb4'x',_utf8mb4'y'))"), { column: 'kind', values: ['x', 'y'] })
  assert.deepEqual(m.parseCheckIn("(`status` in (_utf8mb4\\'new\\',_utf8mb4\\'gone\\'))"), { column: 'status', values: ['new', 'gone'] })
  assert.deepEqual(m.parseCheckIn("CHECK (char_length(name) > 0 AND kind IN ('x')) AND other IN ('z')"), { column: 'kind', values: ['x'] })
  assert.equal(m.parseCheckIn('CHECK (price > 0)'), null)
})

test('makeRows: skip columns left out, null %, unique, length limits, exhaustion error', () => {
  const t = { table: 't', rows: 50, columns: [
    { column: 'id', type: 'integer', kind: 'skip', nullPct: 0, unique: false },
    { column: 'n', type: 'integer', kind: 'int', nullPct: 0, unique: true, min: '1', max: '50' },
    { column: 'c', type: 'varchar(3)', kind: 'words', nullPct: 100, unique: false },
    { column: 'w', type: 'char(2)', kind: 'city', nullPct: 0, unique: false }
  ] }
  const { columns, rows } = m.makeRows(t, 50, m.rng(7))
  assert.deepEqual(columns, ['n', 'c', 'w'])
  assert.equal(new Set(rows.map((r) => r[0])).size, 50)
  assert.ok(rows.every((r) => r[1] === null && String(r[2]).length <= 2))
  assert.throws(() => m.makeRows(t, 51, m.rng(7)), /ran out of unique values/)
  // same seed, same rows
  assert.deepEqual(m.makeRows(t, 50, m.rng(7)).rows, rows)
})

test('fkOrder puts parents first and tolerates self-references and cycles', () => {
  const fk = (column: string, table: string): Record<string, unknown> => ({ column, type: 'int', kind: 'fk', nullPct: 0, unique: false, ref: { schema: 's', table, column: 'id' } })
  const tables = [
    { table: 'items', rows: 1, columns: [fk('order_id', 'orders'), fk('product_id', 'products')] },
    { table: 'orders', rows: 1, columns: [fk('customer_id', 'customers'), fk('parent_id', 'orders')] },
    { table: 'customers', rows: 1, columns: [] },
    { table: 'products', rows: 1, columns: [fk('x', 'elsewhere')] },
    { table: 'a', rows: 1, columns: [fk('b_id', 'b')] },
    { table: 'b', rows: 1, columns: [fk('a_id', 'a')] }
  ]
  const order = m.fkOrder(tables, 's').map((t) => t.table)
  assert.ok(order.indexOf('customers') < order.indexOf('orders'))
  assert.ok(order.indexOf('orders') < order.indexOf('items'))
  assert.ok(order.indexOf('products') < order.indexOf('items'))
  assert.equal(order.length, 6)
})

test('runPlan: SQL mode builds deletes, batches and FK values from the parent rows it generated', async () => {
  const queries: string[] = []
  const db = { dialect: 'postgres' as const, query: async (sql: string) => { queries.push(sql); return { columns: [], rows: [], rowCount: 0, ms: 0, sql } } }
  const plan = {
    schema: 'public', seed: 5, deleteFirst: true,
    tables: [
      { table: 'child', rows: 3, columns: [{ column: 'parent_code', type: 'text', kind: 'fk', nullPct: 0, unique: false, ref: { schema: 'public', table: 'parent', column: 'code' } }] },
      { table: 'parent', rows: 600, columns: [{ column: 'code', type: 'text', kind: 'pattern', text: 'P\\d{6}', nullPct: 0, unique: true }] }
    ]
  }
  const { sql, rows } = await m.runPlan(db, plan, { execute: false })
  assert.equal(rows, 603)
  assert.deepEqual(sql.slice(0, 2), ['DELETE FROM "public"."child"', 'DELETE FROM "public"."parent"'])
  assert.equal(sql.filter((s) => s.startsWith('INSERT INTO "public"."parent"')).length, 2) // 500 + 100
  const child = sql.find((s) => s.startsWith('INSERT INTO "public"."child"'))!
  const codes = [...child.matchAll(/'(P\d{6})'/g)].map((x) => x[1])
  assert.equal(codes.length, 3)
  assert.ok(codes.every((c) => sql.some((s) => s.startsWith('INSERT INTO "public"."parent"') && s.includes(`'${c}'`))))
  assert.ok(queries.every((q) => q.startsWith('SELECT DISTINCT')), 'SQL mode only reads')
  assert.deepEqual(m.planSummary('postgres', plan)[0], 'DELETE FROM "public"."child"')
})
