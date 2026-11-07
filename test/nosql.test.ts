import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  fmtCmd, redisReadOnly, renderRedis, fmtTtl, shell, cellText, typeHint, relaxJson, parseLoose, parseObject, coerceCell,
  unionKeys, collRef, splitJs, jsStatementAt, mongoShellReadOnly, mongoCommandReadOnly, mongoCompletions
} from '../src/renderer/src/lib/nosql.ts'

test('redis command formatting and read-only check', () => {
  assert.equal(fmtCmd(['HSET', 'user:1', 'name', 'Ann Lee', 5]), 'HSET user:1 name "Ann Lee" 5')
  assert.equal(fmtCmd(['SET', 'k', '']), 'SET k ""')
  assert.ok(redisReadOnly('  get foo'))
  assert.ok(redisReadOnly('HGETALL h'))
  assert.ok(!redisReadOnly('DEL foo'))
  assert.ok(!redisReadOnly('FLUSHALL'))
  assert.ok(!redisReadOnly(''))
})

test('redis result rendering', () => {
  assert.equal(renderRedis(null), '(nil)')
  assert.equal(renderRedis(3), '(integer) 3')
  assert.equal(renderRedis('OK'), '"OK"')
  assert.equal(renderRedis([]), '(empty array)')
  assert.equal(renderRedis(['a', null, ['b', 2]]), '1) "a"\n2) (nil)\n3) 1) "b"\n   2) (integer) 2')
  assert.equal(renderRedis('# Server\r\nredis_version:7\r\n'), '# Server\nredis_version:7')
})

test('ttl formatting', () => {
  assert.equal(fmtTtl(-1), 'no expiry')
  assert.equal(fmtTtl(-2), 'expired')
  assert.equal(fmtTtl(45), '45s')
  assert.equal(fmtTtl(725), '12m 5s')
  assert.equal(fmtTtl(3 * 3600 + 120), '3h 2m')
  assert.equal(fmtTtl(2 * 86400 + 4 * 3600), '2d 4h')
})

test('mongo display', () => {
  const id = { $oid: '65a1b2c3d4e5f60718293a4b' }
  assert.equal(cellText(id), 'ObjectId("65a1b2c3d4e5f60718293a4b")')
  assert.equal(cellText({ $date: '2024-01-02T03:04:05.000Z' }), '2024-01-02T03:04:05.000Z')
  assert.equal(cellText({ $date: { $numberLong: '0' } }), '1970-01-01T00:00:00.000Z')
  assert.equal(cellText({ a: 1, 'b c': [id] }), '{a: 1, "b c": [ObjectId("65a1b2c3d4e5f60718293a4b")]}')
  assert.equal(cellText(undefined), undefined)
  assert.equal(cellText(null), null)
  assert.equal(cellText(true), 'true')
  assert.equal(shell({ _id: id }), '{_id: ObjectId("65a1b2c3d4e5f60718293a4b")}')
  assert.equal(typeHint(id), 'ObjectId')
  assert.equal(typeHint([1, 2]), 'Array[2]')
  assert.equal(typeHint({ a: 1 }), 'Object{1}')
  assert.equal(typeHint(1.5), 'Double')
})

test('relaxed JSON parsing round-trips shell text', () => {
  assert.deepEqual(parseLoose('{age: {$gt: 30}}'), { age: { $gt: 30 } })
  assert.deepEqual(parseLoose("{name: 'it\\'s', note: \"a, b: c\"}"), { name: "it's", note: 'a, b: c' })
  assert.deepEqual(parseLoose('{_id: ObjectId("65a1b2c3d4e5f60718293a4b"), n: NumberInt(4)}'), { _id: { $oid: '65a1b2c3d4e5f60718293a4b' }, n: 4 })
  const doc = { _id: { $oid: 'abc' }, at: { $date: '2024-01-02T03:04:05.000Z' }, tags: ['x'], 'odd key': { y: null } }
  assert.deepEqual(parseLoose(shell(doc)), doc)
  assert.equal(relaxJson('{"a": 1}'), '{"a": 1}')
  assert.ok('error' in parseObject('{a: '))
  assert.ok('error' in parseObject('[1]'))
  assert.deepEqual(parseObject('  '), { value: {} })
})

test('cell coercion keeps types', () => {
  assert.equal(coerceCell(5, '7'), 7)
  assert.equal(coerceCell(5, 'abc'), 'abc')
  assert.equal(coerceCell(true, 'FALSE'), false)
  assert.equal(coerceCell('old', '123'), '123')
  assert.equal(coerceCell(null, '123'), 123)
  assert.equal(coerceCell(undefined, 'hello'), 'hello')
  assert.deepEqual(coerceCell({ a: 1 }, '{a: 2}'), { a: 2 })
  assert.deepEqual(coerceCell({ $date: '2024-01-01T00:00:00.000Z' }, '2025-05-06T00:00:00Z'), { $date: '2025-05-06T00:00:00.000Z' })
  assert.deepEqual(coerceCell({ $oid: 'a' }, 'ObjectId("b")'), { $oid: 'b' })
})

test('union keys and collection refs', () => {
  assert.deepEqual(unionKeys([{ b: 1, _id: 1 }, { c: 2, _id: 2, a: 3 }]), ['_id', 'b', 'c', 'a'])
  assert.deepEqual(unionKeys([{ n: 1 }]), ['n'])
  assert.equal(collRef('users'), 'db.users')
  assert.equal(collRef('my-coll'), 'db.getCollection("my-coll")')
})

test('shell statement splitting', () => {
  const t = 'db.a.find({x: ";"})\n  .sort({x: 1}) // trailing; comment\n\ndb.b.countDocuments();db.c.find()'
  const s = splitJs(t)
  assert.deepEqual(s.map((x) => x.sql), ['db.a.find({x: ";"})\n  .sort({x: 1})', 'db.b.countDocuments()', 'db.c.find()'])
  assert.equal(jsStatementAt(t, t.indexOf('countDocuments'))?.sql, 'db.b.countDocuments()')
  assert.equal(jsStatementAt(t, t.length)?.sql, 'db.c.find()')
  assert.deepEqual(splitJs('// only a comment\n/* and another */').length, 0)
  assert.deepEqual(splitJs('db.a.aggregate([\n  {$match: {}}\n])').map((x) => x.sql), ['db.a.aggregate([\n  {$match: {}}\n])'])
})

test('mongo read-only classification', () => {
  assert.ok(mongoShellReadOnly('db.users.find({age: {$gt: 30}}).sort({age: -1})'))
  assert.ok(mongoShellReadOnly('db.getCollection("a b").countDocuments({})'))
  assert.ok(mongoShellReadOnly('db.listCollections().toArray()'))
  assert.ok(!mongoShellReadOnly('db.users.aggregate([{$out: "x"}])'))
  assert.ok(!mongoShellReadOnly('db.users.deleteMany({})'))
  assert.ok(!mongoShellReadOnly('db.a.find().forEach(d => db.b.insertOne(d))'))
  assert.ok(mongoCommandReadOnly('{"listCollections": 1}'))
  assert.ok(mongoCommandReadOnly('{find: "users", filter: {}}'))
  assert.ok(!mongoCommandReadOnly('{"drop": "users"}'))
  assert.ok(!mongoCommandReadOnly('{"aggregate": "u", "pipeline": [{"$merge": "x"}]}'))
  assert.ok(!mongoCommandReadOnly('not json'))
})

test('mongo completions', () => {
  const c = mongoCompletions('x = db.us', ['users', 'my-coll'])
  assert.equal(c?.from, 7)
  assert.equal(c?.options.find((o) => o.label === 'my-coll')?.apply, 'getCollection("my-coll")')
  const m = mongoCompletions('db.users.fi', [])
  assert.equal(m?.from, 9)
  assert.ok(m?.options.some((o) => o.label === 'find'))
  assert.equal(mongoCompletions('foo.bar', []), null)
})
