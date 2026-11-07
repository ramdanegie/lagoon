import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register('data:text/javascript,' + encodeURIComponent(
  'export async function resolve(s, c, next) { try { return await next(s, c) } catch (e) { if (s.startsWith(".") && !s.endsWith(".ts")) return next(s + ".ts", c); throw e } }'
))
const m = await import('../src/shared/datasync.ts')
const t = await import('../src/shared/transfer.ts')

async function* pages(rows: unknown[][], size = 2): AsyncGenerator<unknown[][]> {
  for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size)
}
const collect = async <T>(g: AsyncIterable<T>): Promise<T[]> => { const out: T[] = []; for await (const x of g) out.push(x); return out }

test('cmpStr follows code point order; cmpKey compares numbers numerically', () => {
  assert.ok(m.cmpStr('a', 'b') < 0)
  assert.ok(m.cmpStr('ab', 'a') > 0)
  assert.ok(m.cmpStr('\u{1F600}', '�') > 0) // astral above BMP, unlike UTF-16 order
  assert.ok(m.cmpStr('Z', 'a') < 0)
  assert.ok(m.cmpKey(['10'], [9], [true]) > 0)
  assert.ok(m.cmpKey(['99999999999999999999'], ['100000000000000000000'], [true]) < 0)
  assert.equal(m.cmpKey([1, 'x'], ['1', 'x'], [true, false]), 0)
})

test('normCell: same value from different engines compares equal', () => {
  const ti = (x: string, d: 'postgres' | 'mysql' | 'sqlite'): ReturnType<typeof t.classify> => t.classify(x, d)
  assert.equal(m.normCell('1.50', ti('numeric(10,2)', 'postgres')), m.normCell('1.5', ti('decimal(10,1)', 'mysql')))
  assert.equal(m.normCell(true, ti('boolean', 'postgres')), m.normCell(1, ti('tinyint(1)', 'mysql')))
  assert.equal(m.normCell('{"b": 1, "a": [1, 2]}', ti('jsonb', 'postgres')), m.normCell('{"a":[1,2],"b":1}', ti('json', 'mysql')))
  assert.equal(m.normCell('2024-01-01 12:00:00+02', ti('timestamptz', 'postgres')), m.normCell('2024-01-01 10:00:00.000000', ti('datetime(6)', 'mysql')))
  assert.equal(m.normCell('2024-01-01 10:00:00.120', ti('timestamp', 'postgres')), '2024-01-01 10:00:00.12')
  assert.equal(m.normCell('0.1', ti('real', 'postgres')), m.normCell(0.1, ti('float', 'mysql')))
  assert.equal(m.normCell('90.33333333333333', ti('double precision', 'postgres')), m.normCell(90.33333333333331, ti('double', 'mysql')))
  assert.notEqual(m.normCell('90.3333', ti('double precision', 'postgres')), m.normCell(90.3334, ti('double', 'mysql')))
  assert.notEqual(m.normCell(' Hello ', ti('text', 'postgres')), m.normCell('hello', ti('text', 'postgres')))
  assert.equal(m.normCell(' Hello  World ', ti('text', 'postgres'), { ignoreCase: true, ignoreSpace: true }), 'hello world')
  assert.equal(m.normCell(null, ti('text', 'postgres')), null)
  assert.notEqual(m.normCell('', ti('text', 'postgres')), m.normCell(null, ti('text', 'postgres')))
  assert.equal(m.canonNum('-0.000'), '0')
  assert.equal(m.canonNum('+007.10'), '7.1')
})

test('mergeDiff: insert / update / delete / same across page boundaries', async () => {
  const types = [t.classify('int', 'mysql'), t.classify('text', 'mysql')]
  const src = [[1, 'a'], [2, 'b'], [4, 'd'], [5, 'E'], [7, 'g']]
  const dst = [['1', 'a'], ['3', 'c'], ['4', 'd'], ['5', 'e'], ['6', 'f']]
  const ops = await collect(m.mergeDiff(pages(src), pages(dst, 3), { keyCount: 1, types }))
  assert.deepEqual(ops.map((o) => `${o.kind}:${(o.src ?? o.dst)![0]}`), ['same:1', 'insert:2', 'delete:3', 'same:4', 'update:5', 'delete:6', 'insert:7'])
  assert.deepEqual(ops[4].changed, [1])
  const ci = await collect(m.mergeDiff(pages(src), pages(dst), { keyCount: 1, types, opts: { ignoreCase: true } }))
  assert.equal(ci.find((o) => o.src?.[0] === 5)!.kind, 'same')
  // empty sides
  assert.deepEqual((await collect(m.mergeDiff(pages([]), pages(dst), { keyCount: 1, types }))).map((o) => o.kind), Array(5).fill('delete'))
  assert.deepEqual((await collect(m.mergeDiff(pages(src), pages([]), { keyCount: 1, types }))).map((o) => o.kind), Array(5).fill('insert'))
})

test('mergeDiff: composite keys and duplicate-key detection', async () => {
  const types = [t.classify('text', 'postgres'), t.classify('integer', 'postgres'), t.classify('text', 'postgres')]
  const ops = await collect(m.mergeDiff(pages([['a', '1', 'x'], ['a', '2', 'y'], ['b', '1', 'z']]), pages([['a', '2', 'Y'], ['b', '1', 'z']]), { keyCount: 2, types }))
  assert.deepEqual(ops.map((o) => o.kind), ['insert', 'update', 'same'])
  await assert.rejects(collect(m.mergeDiff(pages([[1], [1]]), pages([]), { keyCount: 1, types: [t.classify('int', 'mysql')] })), /repeat a key/)
  await assert.rejects(collect(m.mergeDiff(pages([]), pages([[2], [1]]), { keyCount: 1, types: [t.classify('int', 'mysql')] })), /target rows/)
})

test('matching and default pairing', () => {
  assert.deepEqual(m.matchTables(['Users', 'orders', 'x'], ['users', 'orders']), ['users', 'orders', null])
  const src = [{ name: 'id', type: 'integer', pk: true }, { name: 'Name', type: 'text' }, { name: 'meta', type: 'jsonb' }, { name: 'only_src', type: 'text' }]
  const dst = [{ name: 'id', type: 'int', pk: true }, { name: 'name', type: 'varchar(20)' }, { name: 'meta', type: 'longblob' }, { name: 'gen', type: 'int', extra: 'generated' }]
  assert.deepEqual(m.commonColumns(src, dst), [['id', 'id'], ['Name', 'name'], ['meta', 'meta']])
  const p = m.defaultPairing(src, dst, 'postgres', 'mysql')
  assert.deepEqual(p, { keys: ['id'], cols: ['Name'], reason: undefined })
  assert.match(m.defaultPairing([{ name: 'a', type: 'text' }], [{ name: 'a', type: 'text' }], 'postgres', 'postgres').reason!, /No primary key/)
  assert.match(m.keyProblem(['id'], [{ name: 'id', type: 'uuid' }], [{ name: 'id', type: 'int' }], 'postgres', 'mysql')!, /incompatible/)
})

test('opSql: statements for the target dialect with converted values', () => {
  const target = { dialect: 'mysql' as const, schema: 'd', table: 't', cols: ['id', 'flag', 'data', 'note'], types: ['int', 'tinyint(1)', 'longblob', 'text'], keyCount: 1 }
  assert.equal(m.opSql(target, { kind: 'insert', src: ['7', true, '\\xff00', "it's"], dst: null, changed: [] }), "INSERT INTO `d`.`t` (`id`, `flag`, `data`, `note`) VALUES (7, 1, X'ff00', 'it''s');")
  assert.equal(m.opSql(target, { kind: 'update', src: ['7', false, null, 'n'], dst: [7, 1, null, 'o'], changed: [1, 3] }), "UPDATE `d`.`t` SET `flag` = 0, `note` = 'n' WHERE `id` = 7;")
  assert.equal(m.opSql(target, { kind: 'delete', src: null, dst: [8, 0, null, null], changed: [] }), 'DELETE FROM `d`.`t` WHERE `id` = 8;')
  assert.equal(m.opSql(target, { kind: 'same', src: [1], dst: [1], changed: [] }), null)
  const pg = { dialect: 'postgres' as const, schema: 'public', table: 't', cols: ['id', 'ok'], types: ['integer', 'boolean'], keyCount: 1 }
  assert.equal(m.opSql(pg, { kind: 'insert', src: [1, 1], dst: null, changed: [] }), 'INSERT INTO "public"."t" ("id", "ok") VALUES (1, TRUE);')
})
