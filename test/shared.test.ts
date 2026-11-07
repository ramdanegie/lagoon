import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitStatements, isReadOnly, statementAt, findParams, applyParams, resultName, chartDirective, withRowLimit, singleTableOf } from '../src/shared/split.ts'
import { lit, selectSql, updateSql, insertSql, deleteSql, filterSql, alterColumnSql, createTableSql } from '../src/shared/sqlgen.ts'

test('split respects strings, comments, dollar quotes', () => {
  const s = splitStatements("select ';' as a; -- x;y\nselect 2; create function f() returns int as $$ begin return 1; end $$ language plpgsql;", 'postgres')
  assert.equal(s.length, 3)
  assert.equal(s[0].sql, "select ';' as a")
  assert.match(s[2].sql, /\$\$ language plpgsql$/)
  assert.equal(splitStatements('select 1;;  ;\n-- only comment', 'postgres').length, 1)
  assert.equal(splitStatements("select 'a\\';b'; select 2", 'mysql').length, 2)
  const script = 'select 1;\nDELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nCREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET NEW.a = 1; END $$\nDELIMITER ;\nselect 3;'
  const parts = splitStatements(script, 'mysql').map((x) => x.sql)
  assert.deepEqual(parts, ['select 1', 'CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END', 'CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET NEW.a = 1; END', 'select 3'])
  assert.equal(splitStatements('DELIMITER $$\nselect 1;', 'postgres').length, 1)
})

test('statementAt finds caret statement', () => {
  const t = 'select 1;\nselect 2;\nselect 3'
  assert.equal(statementAt(t, t.indexOf('2'))?.sql, 'select 2')
  assert.equal(statementAt(t, t.length)?.sql, 'select 3')
})

test('read-only classifier', () => {
  assert.ok(isReadOnly('/*c*/ SELECT * from t'))
  assert.ok(isReadOnly('with x as (select 1) select * from x'))
  assert.ok(!isReadOnly('with x as (delete from t returning *) select * from x'))
  assert.ok(!isReadOnly('update t set a=1'))
  assert.ok(isReadOnly("with x as (select 'delete') select 1"))
  assert.ok(!isReadOnly('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) DELETE FROM t'))
  assert.ok(!isReadOnly('explain analyze update t set a = 1'))
  assert.ok(isReadOnly('EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM t'))
  assert.ok(isReadOnly('EXPLAIN (FORMAT JSON) SELECT 1'))
})

test('literals escape per dialect', () => {
  assert.equal(lit('postgres', "o'neil"), "'o''neil'")
  assert.equal(lit('mysql', 'a\\b'), "'a\\\\b'")
  assert.equal(lit('postgres', '42', 'integer'), '42')
  assert.equal(lit('postgres', '42 or 1=1', 'integer'), "'42 or 1=1'")
  assert.equal(lit('postgres', '1 day', 'interval'), "'1 day'")
  assert.equal(lit('postgres', '5', 'interval'), "'5'")
  assert.equal(lit('mysql', '7', 'bigint unsigned'), '7')
  assert.equal(lit('mysql', null), 'NULL')
  assert.equal(lit('postgres', { raw: 'DEFAULT' }), 'DEFAULT')
})

test('select with filters/sort/paging', () => {
  const cols = [{ name: 'id', type: 'integer' }, { name: 'email', type: 'text' }]
  const q = { schema: 'public', table: 'users', join: 'AND' as const, sort: [{ column: 'id', dir: 'DESC' as const }], limit: 300, offset: 0,
    filters: [{ id: '1', enabled: true, column: 'email', op: 'Contains' as const, value: 'x' }, { id: '2', enabled: true, column: 'id', op: 'IN' as const, value: '1, 2' }] }
  assert.equal(selectSql('postgres', q, cols), `SELECT * FROM "public"."users" WHERE CAST("email" AS TEXT) LIKE '%x%' AND "id" IN (1, 2) ORDER BY "id" DESC LIMIT 300 OFFSET 0`)
  assert.equal(filterSql('mysql', { id: '3', enabled: true, column: '__any__', op: '=', value: 'a' }, cols), "(CAST(`id` AS CHAR) = 'a' OR CAST(`email` AS CHAR) = 'a')")
  assert.equal(filterSql('sqlite', { id: '4', enabled: true, column: 'id', op: 'BETWEEN', value: '1 and 9' }, cols), '"id" BETWEEN 1 AND 9')
})

test('dml', () => {
  assert.equal(updateSql('postgres', 'public', 't', { id: 1 }, { name: "x'y" }), `UPDATE "public"."t" SET "name" = 'x''y' WHERE "id" = 1;`)
  assert.equal(updateSql('mysql', 'db', 't', { a: 'x', b: null }, { a: 'z' }, {}, false), "UPDATE `db`.`t` SET `a` = 'z' WHERE `a` = 'x' AND `b` IS NULL LIMIT 1;")
  assert.equal(insertSql('sqlite', 'main', 't', {}), 'INSERT INTO "t" DEFAULT VALUES;')
  assert.equal(deleteSql('postgres', 's', 't', { id: 5 }), 'DELETE FROM "s"."t" WHERE "id" = 5;')
})

test('ddl', () => {
  assert.deepEqual(alterColumnSql('postgres', 'public', 't', { name: 'a', type: 'int', nullable: true, default: null }, { name: 'b', type: 'int', nullable: false, default: '0' }),
    ['ALTER TABLE "public"."t" RENAME COLUMN "a" TO "b";', 'ALTER TABLE "public"."t" ALTER COLUMN "b" SET NOT NULL;', 'ALTER TABLE "public"."t" ALTER COLUMN "b" SET DEFAULT 0;'])
  assert.throws(() => alterColumnSql('sqlite', 'main', 't', { name: 'a', type: 'int', nullable: true, default: null }, { name: 'a', type: 'text', nullable: true, default: null }))
  assert.match(createTableSql('mysql', 'db', 't', [{ name: 'id', type: 'int', nullable: false, default: null }], ['id']), /PRIMARY KEY \(`id`\)/)
})

test('params, names, charts, limits', () => {
  assert.deepEqual(findParams("select :a, ':b', :a, x::int from t where c = :c", 'colon'), ['a', 'c'])
  assert.equal(applyParams('select * from t where s = :s and n > :n', 'colon', { s: "'x'", n: '3' }), "select * from t where s = 'x' and n > 3")
  assert.equal(applyParams('a = ? and b = ?', 'question', { '?1': '1', '?2': '2' }), 'a = 1 and b = 2')
  assert.equal(resultName('-- name: Recent orders\nselect 1'), 'Recent orders')
  assert.deepEqual(chartDirective('-- lagoon barchart x: month, y: revenue, y: cost\nselect'), { type: 'bar', x: 'month', y: ['revenue', 'cost'] })
  assert.equal(withRowLimit('select * from t;', 100), 'select * from t LIMIT 100')
  assert.equal(withRowLimit('select * from t limit 5', 100), 'select * from t limit 5')
  assert.equal(withRowLimit('update t set a=1', 100), 'update t set a=1')
})

test('singleTableOf: only plain single-table selects are editable', () => {
  assert.deepEqual(singleTableOf('select * from customers'), { table: 'customers' })
  assert.deepEqual(singleTableOf('SELECT id, name FROM public.customers WHERE city = \'x\' ORDER BY id LIMIT 10;'), { schema: 'public', table: 'customers' })
  assert.deepEqual(singleTableOf('select * from "My Schema"."Order Items" o where o.id > 1'), { schema: 'My Schema', table: 'Order Items' })
  assert.deepEqual(singleTableOf('select * from `shop`.`products`'), { schema: 'shop', table: 'products' })
  assert.deepEqual(singleTableOf('-- name: x\nselect * from t as a'), { table: 't' })
  assert.equal(singleTableOf('select * from a join b on a.id = b.id'), null)
  assert.equal(singleTableOf('select * from a, b'), null)
  assert.equal(singleTableOf('select city, count(*) from customers group by city'), null)
  assert.equal(singleTableOf('select distinct city from customers'), null)
  assert.equal(singleTableOf('select * from (select 1) x'), null)
  assert.equal(singleTableOf('with x as (select 1) select * from x'), null)
  assert.equal(singleTableOf('select * from a union select * from b'), null)
  assert.equal(singleTableOf('update t set a = 1'), null)
  assert.deepEqual(singleTableOf("select * from t where note = 'join group by'"), { table: 't' })
})
