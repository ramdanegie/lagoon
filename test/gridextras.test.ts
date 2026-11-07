import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterSql, whereSql, selectSql } from '../src/shared/sqlgen.ts'
import { findRegex, cellMatches, replaceCell } from '../src/renderer/src/lib/gridfind.ts'
import { saveProfile, renameProfile, deleteProfile, type TableProfile } from '../src/renderer/src/lib/profiles.ts'

const cols = [{ name: 'id', type: 'integer' }, { name: 'name', type: 'text' }]
const f = (p: Record<string, unknown>): Parameters<typeof filterSql>[1] => ({ id: 'x', enabled: true, column: 'name', op: '=', value: '', ...p }) as Parameters<typeof filterSql>[1]

test('IS EMPTY / IS NOT EMPTY compare the text form', () => {
  assert.equal(filterSql('postgres', f({ op: 'IS EMPTY' }), cols), `CAST("name" AS TEXT) = ''`)
  assert.equal(filterSql('mysql', f({ op: 'IS NOT EMPTY', column: 'id' }), cols), "CAST(`id` AS CHAR) <> ''")
  assert.equal(filterSql('sqlite', f({ op: 'IS EMPTY' }), cols), `"name" = ''`)
  assert.equal(filterSql('postgres', f({ op: 'IS EMPTY', column: '__any__' }), cols), `(CAST("id" AS TEXT) = '' OR CAST("name" AS TEXT) = '')`)
})

test('NOT toggle wraps a condition, skips empty raw', () => {
  assert.equal(filterSql('postgres', f({ op: '=', value: 'a', not: true }), cols), `NOT ("name" = 'a')`)
  assert.equal(filterSql('postgres', f({ column: '__raw__', value: 'id > 1', not: true }), cols), 'NOT ((id > 1))')
  assert.equal(filterSql('postgres', f({ column: '__raw__', value: ' ', not: true }), cols), '')
  assert.equal(whereSql('postgres', [f({ op: 'IS NULL', not: true }), f({ id: 'y', column: 'id', op: '>', value: '2' })], 'AND', cols), ` WHERE NOT ("name" IS NULL) AND "id" > 2`)
})

test('FK picker query shape', () => {
  const q = { schema: 'public', table: 'customers', filters: [f({ column: '__any__', op: 'Contains', value: 'ann' })], join: 'AND' as const, sort: [{ column: 'id', dir: 'ASC' as const }], limit: 1000, offset: 0, columns: ['id', 'name'] }
  assert.equal(selectSql('postgres', q, cols), `SELECT "id", "name" FROM "public"."customers" WHERE (CAST("id" AS TEXT) LIKE '%ann%' OR CAST("name" AS TEXT) LIKE '%ann%') ORDER BY "id" ASC LIMIT 1000 OFFSET 0`)
})

test('grid find: plain text is escaped, case and whole-cell options', () => {
  const re = findRegex({ find: 'a.b', matchCase: false, wholeCell: false, regex: false })!
  assert.ok(cellMatches(re, 'xA.By'))
  assert.ok(!cellMatches(re, 'axb'))
  assert.ok(!cellMatches(findRegex({ find: 'a', matchCase: true, wholeCell: false, regex: false })!, 'A'))
  const whole = findRegex({ find: 'ab', matchCase: false, wholeCell: true, regex: false })!
  assert.ok(cellMatches(whole, 'AB'))
  assert.ok(!cellMatches(whole, 'abc'))
  assert.equal(findRegex({ find: '(', matchCase: false, wholeCell: false, regex: true }), null)
  assert.equal(findRegex({ find: '', matchCase: false, wholeCell: false, regex: false }), null)
})

test('grid replace: all occurrences, $ literal unless regex', () => {
  const o = { find: 'o', matchCase: false, wholeCell: false, regex: false }
  assert.equal(replaceCell(findRegex(o)!, 'foo', '$1', false), 'f$1$1')
  const rx = findRegex({ ...o, find: '(\\d+)-(\\d+)', regex: true })!
  assert.equal(replaceCell(rx, '10-20', '$2-$1', true), '20-10')
  assert.equal(replaceCell(findRegex({ ...o, find: 'foo', wholeCell: true })!, 'FOO', 'bar', false), 'bar')
})

test('profiles: save replaces by name, rename, delete drops empty table key', () => {
  const p = (name: string, n = 0): TableProfile => ({ name, filters: [], applied: [], join: 'AND', sort: [], visible: null, widths: { a: n } })
  let m = saveProfile({}, 't', p('a'))
  m = saveProfile(m, 't', p('b'))
  m = saveProfile(m, 't', p('a', 5))
  assert.deepEqual(m.t.map((x) => [x.name, x.widths.a]), [['a', 5], ['b', 0]])
  assert.deepEqual(renameProfile(m, 't', 'a', 'b').t.map((x) => [x.name, x.widths.a]), [['b', 5]])
  assert.equal(renameProfile(m, 't', 'a', 'a'), m)
  assert.deepEqual(Object.keys(deleteProfile(deleteProfile(m, 't', 'a'), 't', 'b')), [])
})
