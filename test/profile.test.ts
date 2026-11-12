import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

register('data:text/javascript,' + encodeURIComponent(
  'export async function resolve(s, c, next) { try { return await next(s, c) } catch (e) { if (s.startsWith(".") && !s.endsWith(".ts")) return next(s + ".ts", c); throw e } }'
))
const { profileSql, histSql, readProfile } = await import('../src/shared/profile.ts')

const db = new DatabaseSync(':memory:')
db.exec(`create table t (id integer, name text, score real);
  insert into t values (1,'ann',0),(2,'bob',10),(3,null,10),(4,'ann',25),(5,'carla',100)`)
const rows = (sql: string): unknown[][] => db.prepare(sql).all().map((r) => Object.values(r as object))

test('profile: nulls, distinct, min/max, text length, top values on SQLite', () => {
  const q = profileSql('sqlite', 'main', 't', 'name', 'TEXT', null)
  const p = readProfile(rows(q.stats)[0], rows(q.top))
  assert.equal(p.total, 5); assert.equal(p.nulls, 1); assert.equal(p.distinct, 3)
  assert.equal(p.min, 'ann'); assert.equal(p.max, 'carla'); assert.equal(p.avg, null)
  assert.equal(p.minLen, 3); assert.equal(p.maxLen, 5)
  assert.deepEqual(p.top[0], { v: 'ann', n: 2 })
  assert.equal(p.top.length, 4, 'NULL is listed as a value too')
})

test('profile: numeric average, histogram puts the maximum in the last bucket, sample limits rows', () => {
  const q = profileSql('sqlite', 'main', 't', 'score', 'REAL', null)
  const stats = rows(q.stats)[0]
  const p0 = readProfile(stats, [])
  assert.equal(p0.avg, 29); assert.equal(p0.min, '0'); assert.equal(p0.max, '100')
  const h = readProfile(stats, [], rows(histSql('sqlite', 'main', 't', 'score', 0, 100, null)), { min: 0, max: 100 }).hist
  assert.equal(h.length, 10)
  assert.deepEqual(h.map((b) => b.n), [1, 2, 1, 0, 0, 0, 0, 0, 0, 1])
  assert.deepEqual([h[0].from, h[9].to], [0, 100])
  assert.equal(readProfile(rows(profileSql('sqlite', 'main', 't', 'id', 'integer', 2).stats)[0], []).total, 2)
})

test('profile SQL: quoting per dialect, text cast for plain mode, no avg on text', () => {
  const pg = profileSql('postgres', 'public', 'Odd "t"', 'meta', 'jsonb', 1000, true)
  assert.match(pg.stats, /count\(DISTINCT CAST\(v AS TEXT\)\)/)
  assert.match(pg.stats, /FROM "public"\."Odd ""t"""\s+LIMIT 1000\) s$/)
  assert.match(pg.stats, /, NULL, NULL, NULL FROM/)
  const my = profileSql('mysql', 'shop', 'users', 'name', 'varchar(20)', null)
  assert.match(my.stats, /CHAR_LENGTH\(v\)/)
  assert.match(my.top, /^SELECT CAST\(v AS CHAR\), count\(\*\) FROM \(SELECT `name` AS v FROM `shop`\.`users`\) s GROUP BY 1/)
  assert.match(histSql('postgres', 'public', 't', 'n', -5, 15, null), /^SELECT FLOOR\(\(v - -5\) \/ 2\)/)
})
