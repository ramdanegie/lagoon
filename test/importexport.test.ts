import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// importexport.ts imports './sqlgen' without an extension (bundler style); let Node retry with .ts
register('data:text/javascript,' + encodeURIComponent(
  'export async function resolve(s, c, next) { try { return await next(s, c) } catch (e) { if (s.startsWith(".") && !s.endsWith(".ts")) return next(s + ".ts", c); throw e } }'
))
const m = await import('../src/shared/importexport.ts')

test('parseDelimited: quotes, escaped quotes, newlines in cells, CRLF, blank lines', () => {
  assert.deepEqual(m.parseDelimited('a,b\r\n"x,1","he said ""hi"""\n\n"multi\nline",\n'), [['a', 'b'], ['x,1', 'he said "hi"'], ['multi\nline', '']])
  assert.deepEqual(m.parseDelimited("a;'b;c'", ';', "'"), [['a', 'b;c']])
  assert.deepEqual(m.parseDelimited('a\t"b"\tc', '\t', ''), [['a', '"b"', 'c']])
  assert.deepEqual(m.parseDelimited('1,2'), [['1', '2']])
})

test('parseJsonRecords: array, single object, NDJSON, errors', () => {
  assert.equal(m.parseJsonRecords('[{"a":1},{"b":2}]').length, 2)
  assert.deepEqual(m.parseJsonRecords('{\n "a": 1\n}'), [{ a: 1 }])
  assert.deepEqual(m.parseJsonRecords('{"a":1}\n{"a":2,"b":3}\n'), [{ a: 1 }, { a: 2, b: 3 }])
  assert.deepEqual(m.jsonColumns([{ a: 1 }, { a: 2, b: 3 }]), ['a', 'b'])
  assert.throws(() => m.parseJsonRecords('[1,2]'), /not a JSON object/)
  assert.throws(() => m.parseJsonRecords('{"a":1}\nnope'), /Line 2/)
})

test('detectType per dialect', () => {
  assert.equal(m.detectType(['1', '2', ''], 'postgres'), 'integer')
  assert.equal(m.detectType(['1', '99999999999'], 'postgres'), 'bigint')
  assert.equal(m.detectType(['1.5', '-2', '3e4'], 'mysql'), 'double')
  assert.equal(m.detectType(['true', 'FALSE'], 'postgres'), 'boolean')
  assert.equal(m.detectType(['2024-01-02'], 'sqlite'), 'DATE')
  assert.equal(m.detectType(['2024-01-02 10:11:12'], 'mysql'), 'datetime')
  assert.equal(m.detectType(['007', 'abc'], 'postgres'), 'text')
  assert.equal(m.detectType([], 'postgres'), 'text')
})

test('uniqueNames', () => {
  assert.deepEqual(m.uniqueNames(['id', '', 'ID', 'name']), ['id', 'column_2', 'ID_2', 'name'])
})

test('matchColumns strategies', () => {
  const dest = ['id', 'name', 'email']
  assert.deepEqual(m.matchColumns(['name', 'id', 'x'], dest, 'name'), ['name', 'id', null])
  assert.deepEqual(m.matchColumns(['Name', 'ID'], dest, 'name', true), ['name', 'id'])
  assert.deepEqual(m.matchColumns(['a', 'b', 'c', 'd'], dest, 'order'), ['id', 'name', 'email', null])
  // name first, then position when the positional column is not claimed by a name match
  assert.deepEqual(m.matchColumns(['x', 'id', 'y'], dest, 'nameOrder'), [null, 'id', 'email'])
})

test('expandPattern', () => {
  const d = new Date(2025, 0, 5, 9, 8, 7)
  assert.equal(m.expandPattern('{connection}_{table}_{date}_{time}', { connection: 'prod/db', table: 'users' }, d), 'prod_db_users_2025-01-05_09-08-07')
  assert.equal(m.expandPattern('{schema}.{table}', { table: 'x', schema: undefined }, d), 'x')
  assert.equal(m.expandPattern('', {}, d), 'export')
})

test('splitArgs and toolArgs keep passwords out of argv', () => {
  assert.deepEqual(m.splitArgs(`--format=custom  --exclude-table="a b" -n 'x'`), ['--format=custom', '--exclude-table=a b', '-n', 'x'])
  const t = { host: '127.0.0.1', port: 5432, user: 'tc', database: 'app' }
  assert.deepEqual(m.toolArgs('pg_dump', t, '--format=custom'), ['-h', '127.0.0.1', '-p', '5432', '-U', 'tc', '-w', '-d', 'app', '--format=custom'])
  assert.deepEqual(m.toolArgs('mysqldump', { ...t, port: 3306 }, '--single-transaction'), ['-h', '127.0.0.1', '-P', '3306', '--protocol=TCP', '-u', 'tc', '--single-transaction', 'app'])
  assert.deepEqual(m.toolArgs('psql', t, '--single-transaction --clean').slice(-3), ['-v', 'ON_ERROR_STOP=1', '--single-transaction'])
  assert.ok(m.isArchiveFormat('--format=custom') && m.isArchiveFormat('-Fc') && !m.isArchiveFormat('--format=plain') && !m.isArchiveFormat(''))
})

test('csvRow options', () => {
  const o = { ...m.CSV_DEFAULTS }
  assert.equal(m.csvRow(['a,b', null, 'x"y', 1.5], o), '"a,b",NULL,"x""y",1.5')
  assert.equal(m.csvRow(['1.25', null, 'a\nb'], { ...o, delimiter: ';', decimal: ',', nullAsEmpty: true, breakToSpace: true }, [true]), '1,25;;a b')
  assert.equal(m.csvRow(["it's"], { ...o, quote: "'" }), "'it''s'")
})

test('importValue / typedValue / exportValue', () => {
  assert.equal(m.importValue('', 'integer'), null)
  assert.equal(m.importValue('', 'text'), '')
  assert.equal(m.importValue('TRUE', 'boolean'), true)
  assert.equal(m.importValue({ a: 1 }, 'jsonb'), '{"a":1}')
  assert.equal(m.typedValue('42', true), 42)
  assert.equal(m.typedValue('0042', true), '0042')
  assert.equal(m.typedValue('42', false), '42')
  assert.deepEqual(m.exportValue('mysql', '\\xff00', 'blob'), { raw: "X'ff00'" })
  assert.equal(m.exportValue('postgres', '\\xff00', 'bytea'), '\\xff00')
})

test('insertManySql conflict modes', () => {
  const rows = [[1, 'a'], [2, null]]
  assert.equal(m.insertManySql('postgres', 'public', 't', ['id', 'n'], rows, ['integer', 'text']), 'INSERT INTO "public"."t" ("id", "n") VALUES\n(1, \'a\'),\n(2, NULL)')
  assert.match(m.insertManySql('postgres', 'public', 't', ['id', 'n'], rows, [], 'update', ['id']), /ON CONFLICT \("id"\) DO UPDATE SET "n" = EXCLUDED\."n"$/)
  assert.match(m.insertManySql('postgres', 'public', 't', ['id'], [[1]], [], 'update', ['id']), /DO NOTHING$/)
  assert.throws(() => m.insertManySql('postgres', 'public', 't', ['id'], [[1]], [], 'update', []), /primary key/)
  assert.match(m.insertManySql('mysql', 'db', 't', ['id', 'n'], rows, [], 'update'), /ON DUPLICATE KEY UPDATE `id` = VALUES\(`id`\), `n` = VALUES\(`n`\)$/)
  assert.match(m.insertManySql('mysql', 'db', 't', ['id'], [[1]], [], 'replace'), /^REPLACE INTO `db`\.`t`/)
})

test('import modes: skip, upsert on SQLite, update, delete, truncate, key validation', () => {
  const rows = [[1, 'a'], [2, null]]
  const cols = ['id', 'n']
  assert.match(m.insertManySql('postgres', 'public', 't', cols, rows, [], 'skip'), /^INSERT INTO "public"\."t" .* ON CONFLICT DO NOTHING$/s)
  assert.match(m.insertManySql('mysql', 'db', 't', cols, rows, [], 'skip'), /^INSERT IGNORE INTO `db`\.`t`/)
  assert.match(m.insertManySql('sqlite', 'main', 't', cols, rows, [], 'skip'), /^INSERT OR IGNORE INTO "t"/)
  assert.match(m.insertManySql('sqlite', 'main', 't', cols, rows, [], 'update', ['id']), /ON CONFLICT \("id"\) DO UPDATE SET "n" = EXCLUDED\."n"$/)
  assert.match(m.insertManySql('sqlite', 'main', 't', cols, rows, [], 'replace'), /^INSERT OR REPLACE INTO "t"/)
  assert.deepEqual(m.importBatchSql('postgres', 'public', 't', cols, rows, ['integer', 'text'], 'updateOnly', ['id']), [
    'UPDATE "public"."t" SET "n" = \'a\' WHERE "id" = 1',
    'UPDATE "public"."t" SET "n" = NULL WHERE "id" = 2'
  ])
  assert.deepEqual(m.importBatchSql('mysql', 'db', 't', cols, rows, ['int', 'text'], 'delete', ['id']), ['DELETE FROM `db`.`t` WHERE `id` IN (1, 2)'])
  assert.deepEqual(m.importBatchSql('postgres', 'public', 't', ['a', 'b', 'v'], [[1, 'x', 0]], [], 'delete', ['a', 'b']), ['DELETE FROM "public"."t" WHERE ("a" = 1 AND "b" = \'x\')'])
  assert.match(m.importBatchSql('postgres', 'public', 't', cols, rows, [], 'truncate', [])[0], /^INSERT INTO "public"\."t" \("id", "n"\) VALUES/)
  assert.throws(() => m.importBatchSql('postgres', 'public', 't', cols, rows, [], 'updateOnly', []), /needs key columns/)
  assert.throws(() => m.importBatchSql('postgres', 'public', 't', ['n'], [['a']], [], 'delete', ['id']), /not imported/)
  assert.throws(() => m.importBatchSql('postgres', 'public', 't', ['id'], [[1]], [], 'updateOnly', ['id']), /Nothing to update/)
  assert.equal(m.needsKeys('update', 'mysql'), false)
  assert.equal(m.needsKeys('update', 'postgres'), true)
  assert.equal(m.needsKeys('skip', 'postgres'), false)
  assert.equal(m.needsKeys('delete', 'mysql'), true)
})
