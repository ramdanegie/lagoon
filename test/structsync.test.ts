import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import type * as SS from '../src/shared/structsync.ts'

// structsync imports './sqlgen' without an extension (the bundler resolves it); teach Node to try .ts
register('data:text/javascript,' + encodeURIComponent('export async function resolve(s, c, next) { try { return await next(s, c) } catch (e) { if (s.startsWith(".") && !s.endsWith(".ts")) return next(s + ".ts", c); throw e } }'))
const { diffSchemas, buildScript, scriptText, canUseTransaction, lineDiff, topo, parseMysqlCreateTable, caseSensitive, DEFAULT_SYNC_OPTIONS }: typeof SS = await import('../src/shared/structsync.ts')

type Col = SS.SColumn
const col = (name: string, type: string, over: Partial<Col> = {}): Col => ({ name, type, nullable: true, default: null, comment: null, collation: null, extra: null, generated: null, ...over })
const pk = (name: string, cols: string[]): SS.SConstraint => ({ name, kind: 'pk', def: `PRIMARY KEY (${cols.join(', ')})`, columns: cols })
const fk = (name: string, cols: string[], refTable: string, refColumns: string[]): SS.SConstraint => ({ name, kind: 'fk', def: `FOREIGN KEY (${cols.join(', ')}) REFERENCES ${refTable}(${refColumns.join(', ')})`, columns: cols, refTable, refSchema: null, refColumns })
const table = (name: string, columns: Col[], over: Partial<SS.STable> = {}): SS.STable => ({ name, columns, constraints: [], indexes: [], comment: null, collation: null, options: null, ...over })
const model = (over: Partial<SS.SchemaModel>, dialect: SS.SyncDialect = 'postgres', schema = 'app'): SS.SchemaModel =>
  ({ dialect, schema, lowerCaseNames: 0, tables: [], views: [], routines: [], triggers: [], sequences: [], enums: [], ...over })
const opts = (over: Partial<SS.SyncOptions> = {}): SS.SyncOptions => ({ ...DEFAULT_SYNC_OPTIONS, ...over })
const all = (items: SS.DiffItem[], o: SS.SyncDialect = 'postgres', schema = 'app'): string[] => buildScript(items, () => true, { dialect: o, schema })
const byId = (items: SS.DiffItem[], id: string): SS.DiffItem => items.find((i) => i.id === id)!

test('postgres: columns added, changed and dropped; drops are opt-in', () => {
  const src = model({ tables: [table('t', [col('id', 'integer', { nullable: false, extra: 'serial', seq: 't_id_seq' }), col('qty', 'bigint', { nullable: false, default: '0' }), col('note', 'text', { comment: 'hi' })], { constraints: [pk('t_pkey', ['id'])] })] })
  const dst = model({ tables: [table('t', [col('id', 'integer', { nullable: false, extra: 'serial', seq: 't_id_seq' }), col('qty', 'integer'), col('legacy', 'text')], { constraints: [pk('t_pkey', ['id'])] })] })
  const items = diffSchemas(src, dst, opts())
  const t = byId(items, 'table:t')
  assert.equal(t.op, 'alter')
  assert.deepEqual(all(items), [
    'SET search_path TO "app";',
    'ALTER TABLE "app"."t" ADD COLUMN "note" text;',
    `COMMENT ON COLUMN "app"."t"."note" IS 'hi';`,
    'ALTER TABLE "app"."t" ALTER COLUMN "qty" TYPE bigint USING "qty"::bigint;',
    'ALTER TABLE "app"."t" ALTER COLUMN "qty" SET NOT NULL;',
    'ALTER TABLE "app"."t" ALTER COLUMN "qty" SET DEFAULT 0;'
  ])
  const withDrops = diffSchemas(src, dst, opts({ drops: true }))
  const script = all(withDrops)
  assert.ok(script.includes('ALTER TABLE "app"."t" DROP COLUMN "legacy";'))
  assert.ok(byId(withDrops, 'table:t').details.some((x) => /legacy → note looks like a rename/.test(x)))
  // the CREATE TABLE in the DDL view shows serial without its sequence default
  assert.match(t.src, /"id" serial NOT NULL/)
})

test('postgres: new tables are created in FK order and FKs are added after all tables', () => {
  const src = model({ tables: [
    table('orders', [col('id', 'integer', { nullable: false }), col('customer_id', 'integer')], { constraints: [pk('orders_pkey', ['id']), fk('orders_customer_fk', ['customer_id'], 'customers', ['id'])] }),
    table('customers', [col('id', 'integer', { nullable: false })], { constraints: [pk('customers_pkey', ['id'])], indexes: [{ name: 'customers_x', def: 'USING btree (id)', unique: false, columns: ['id'] }] })
  ] })
  const items = diffSchemas(src, model({}), opts())
  const s = all(items)
  const iCust = s.findIndex((x) => x.startsWith('CREATE TABLE "app"."customers"'))
  const iOrd = s.findIndex((x) => x.startsWith('CREATE TABLE "app"."orders"'))
  const iFk = s.findIndex((x) => x.includes('ADD CONSTRAINT "orders_customer_fk"'))
  assert.ok(iCust > 0 && iCust < iOrd && iOrd < iFk, s.join('\n'))
  assert.ok(s.includes('CREATE INDEX "customers_x" ON "app"."customers" USING btree (id);'))
  assert.doesNotMatch(s[iOrd], /FOREIGN KEY/)
  assert.match(byId(items, 'table:orders').src, /CONSTRAINT "orders_customer_fk" FOREIGN KEY/)
})

test('postgres: an FK that blocks a referenced column type change is dropped first and re-added last', () => {
  const mk = (idType: string, refType: string): SS.SchemaModel => model({ tables: [
    table('a', [col('id', idType, { nullable: false })], { constraints: [pk('a_pkey', ['id'])] }),
    table('b', [col('a_id', refType)], { constraints: [fk('b_a_fk', ['a_id'], 'a', ['id'])] })
  ] })
  const items = diffSchemas(mk('bigint', 'bigint'), mk('integer', 'integer'), opts())
  const s = all(items)
  const drop = s.indexOf('ALTER TABLE "app"."b" DROP CONSTRAINT "b_a_fk";')
  const alterA = s.indexOf('ALTER TABLE "app"."a" ALTER COLUMN "id" TYPE bigint USING "id"::bigint;')
  const add = s.indexOf('ALTER TABLE "app"."b" ADD CONSTRAINT "b_a_fk" FOREIGN KEY (a_id) REFERENCES a(id);')
  assert.ok(drop > 0 && drop < alterA && alterA < add, s.join('\n'))
  assert.equal(s.filter((x) => x.includes('DROP CONSTRAINT "b_a_fk"')).length, 1, 'deduplicated across both causes')
  // unchecking both tables removes the rebuild with them
  assert.deepEqual(buildScript(items, () => false, { dialect: 'postgres', schema: 'app' }), [])
})

test('postgres: a changed FK replaces the rebuild of the same FK', () => {
  const src = model({ tables: [table('a', [col('id', 'bigint')]), table('b', [col('a_id', 'bigint')], { constraints: [{ ...fk('b_a_fk', ['a_id'], 'a', ['id']), def: 'FOREIGN KEY (a_id) REFERENCES a(id) ON DELETE CASCADE' }] })] })
  const dst = model({ tables: [table('a', [col('id', 'integer')]), table('b', [col('a_id', 'integer')], { constraints: [fk('b_a_fk', ['a_id'], 'a', ['id'])] })] })
  const s = all(diffSchemas(src, dst, opts()))
  const adds = s.filter((x) => x.includes('ADD CONSTRAINT "b_a_fk"'))
  assert.deepEqual(adds, ['ALTER TABLE "app"."b" ADD CONSTRAINT "b_a_fk" FOREIGN KEY (a_id) REFERENCES a(id) ON DELETE CASCADE;'])
})

test('postgres: views are dropped before and recreated after table changes they depend on', () => {
  const t = (type: string): SS.STable => table('t', [col('id', 'integer'), col('v', type)])
  const src = model({ tables: [t('numeric(12,2)')], views: [{ name: 'v1', def: 'SELECT t.id, t.v FROM t' }, { name: 'v2', def: 'SELECT v1.id FROM v1' }] })
  const dst = model({ tables: [t('numeric(10,2)')], views: [{ name: 'v1', def: 'SELECT t.id, t.v FROM t' }, { name: 'v2', def: 'SELECT v1.id FROM v1 WHERE true' }] })
  const items = diffSchemas(src, dst, opts())
  assert.equal(byId(items, 'view:v1').op, 'same')
  assert.equal(byId(items, 'view:v2').op, 'alter')
  const s = all(items)
  const idx = (x: string): number => s.indexOf(x)
  assert.ok(idx('DROP VIEW IF EXISTS "app"."v2";') < idx('DROP VIEW IF EXISTS "app"."v1";'), 'dependents dropped first')
  assert.ok(idx('DROP VIEW IF EXISTS "app"."v1";') < idx('ALTER TABLE "app"."t" ALTER COLUMN "v" TYPE numeric(12,2) USING "v"::numeric(12,2);'))
  assert.ok(idx('CREATE VIEW "app"."v1" AS\nSELECT t.id, t.v FROM t;') < idx('CREATE VIEW "app"."v2" AS\nSELECT v1.id FROM v1;'))
  assert.equal(s.filter((x) => x.startsWith('CREATE VIEW "app"."v2"')).length, 1, 'own change wins over the rebuild')
  // MySQL views do not block column changes
  assert.ok(!all(diffSchemas({ ...src, dialect: 'mysql', views: [src.views[0]] }, { ...dst, dialect: 'mysql', views: [dst.views[0]] }, opts()), 'mysql').some((x) => x.includes('VIEW')))
})

test('postgres: routines replace in place unless the return type changes; triggers drop and recreate', () => {
  const fn = (body: string, result = 'integer'): SS.SRoutine => ({ name: 'f', kind: 'function', args: 'a integer', result, def: `CREATE OR REPLACE FUNCTION f(a integer)\n RETURNS ${result}\n LANGUAGE sql\nAS $function$${body}$function$\n` })
  const trg = (when: string): SS.STrigger => ({ name: 'trg', table: 't', def: `CREATE TRIGGER trg ${when} INSERT ON t FOR EACH ROW EXECUTE FUNCTION tf()` })
  let s = all(diffSchemas(model({ routines: [fn('select a+1')], triggers: [trg('BEFORE')] }), model({ routines: [fn('select a')], triggers: [trg('AFTER')] }), opts()))
  assert.deepEqual(s.slice(1), [
    'DROP TRIGGER IF EXISTS "trg" ON "app"."t";',
    'CREATE OR REPLACE FUNCTION f(a integer)\n RETURNS integer\n LANGUAGE sql\nAS $function$select a+1$function$;',
    'CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION tf();'
  ])
  s = all(diffSchemas(model({ routines: [fn('select 1::bigint', 'bigint')] }), model({ routines: [fn('select a')] }), opts()))
  assert.equal(s[1], 'DROP FUNCTION "app"."f"(a integer);')
  // overloads are separate objects
  const other: SS.SRoutine = { ...fn('select 1'), args: 'a text', def: 'CREATE OR REPLACE FUNCTION f(a text) ...' }
  const items = diffSchemas(model({ routines: [fn('select a'), other] }), model({ routines: [fn('select a')] }), opts())
  assert.deepEqual(items.map((i) => [i.name, i.op]).sort(), [['f(a integer)', 'same'], ['f(a text)', 'create']])
})

test('postgres: sequences, enum values and the transaction rule', () => {
  const seq = (inc: string): SS.SSequence => ({ name: 's', type: 'bigint', start: '1', increment: inc, min: '1', max: '9223372036854775807', cache: '1', cycle: false })
  const items = diffSchemas(model({ sequences: [seq('5')], enums: [{ name: 'mood', values: ['sad', 'ok', 'happy'] }] }), model({ sequences: [seq('1')], enums: [{ name: 'mood', values: ['sad', 'happy'] }] }), opts())
  const s = all(items)
  assert.ok(s.includes(`ALTER TYPE "app"."mood" ADD VALUE 'ok' AFTER 'sad';`))
  assert.ok(s.includes('ALTER SEQUENCE "app"."s" AS bigint INCREMENT BY 5 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;'))
  assert.equal(canUseTransaction(s, 'postgres'), false)
  assert.equal(canUseTransaction(s.filter((x) => !x.includes('ADD VALUE')), 'postgres'), true)
  assert.equal(canUseTransaction(['CREATE TABLE t (a int);'], 'mysql'), false)
  const removed = diffSchemas(model({ enums: [{ name: 'e', values: ['a'] }] }), model({ enums: [{ name: 'e', values: ['a', 'b'] }] }), opts())
  assert.match(removed[0].details.join(), /cannot do that in place/)
})

test('drops: target-only objects only appear when drops are on; cascade is PG only', () => {
  const dst = model({ tables: [table('old', [col('a', 'integer')])], views: [{ name: 'v', def: 'SELECT 1' }] })
  assert.deepEqual(diffSchemas(model({}), dst, opts()), [])
  const items = diffSchemas(model({}), dst, opts({ drops: true, cascade: true }))
  const s = all(items)
  assert.ok(s.indexOf('DROP VIEW IF EXISTS "app"."v" CASCADE;') < s.indexOf('DROP TABLE "app"."old" CASCADE;'), 'views first, tables last')
  assert.ok(all(diffSchemas(model({}, 'mysql'), { ...dst, dialect: 'mysql' }, opts({ drops: true, cascade: true })), 'mysql').includes('DROP TABLE `app`.`old`;'))
})

test('drops: FKs pointing at a dropped table go first, before the table', () => {
  const dst = model({ tables: [table('a', [col('id', 'integer')]), table('b', [col('a_id', 'integer')], { constraints: [fk('b_a_fk', ['a_id'], 'a', ['id'])] })] })
  const src = model({ tables: [table('b', [col('a_id', 'integer')])] })
  const s = all(diffSchemas(src, dst, opts({ drops: true })))
  assert.ok(s.indexOf('ALTER TABLE "app"."b" DROP CONSTRAINT "b_a_fk";') < s.indexOf('DROP TABLE "app"."a";'))
  assert.equal(s.filter((x) => x.includes('b_a_fk')).length, 1)
})

test('options switch comparisons off', () => {
  const src = model({ tables: [table('t', [col('a', 'integer', { default: '1', comment: 'x' })], { indexes: [{ name: 'i', def: 'USING btree (a)', unique: false, columns: ['a'] }] })] })
  const dst = model({ tables: [table('t', [col('a', 'integer')])] })
  assert.equal(diffSchemas(src, dst, opts({ defaults: false, comments: false, indexes: false }))[0].op, 'same')
  assert.deepEqual(diffSchemas(src, dst, opts({ tables: false })), [])
})

test('case sensitivity: server default follows lower_case_table_names on MySQL, always sensitive on PG', () => {
  const my = (lc: number): SS.SchemaModel => model({ lowerCaseNames: lc }, 'mysql')
  assert.equal(caseSensitive(opts(), my(0), my(0)), true)
  assert.equal(caseSensitive(opts(), my(0), my(2)), false)
  assert.equal(caseSensitive(opts({ caseMode: 'sensitive' }), my(1), my(1)), true)
  assert.equal(caseSensitive(opts(), model({ lowerCaseNames: 1 }), model({})), true)
  const items = diffSchemas(model({ tables: [table('Users', [col('a', 'int')])], lowerCaseNames: 2 }, 'mysql'), model({ tables: [table('users', [col('a', 'int')])] }, 'mysql'), opts())
  assert.deepEqual(items.map((i) => i.op), ['same'])
})

const MY_CREATE = [
  'CREATE TABLE `orders` (',
  '  `id` int NOT NULL AUTO_INCREMENT,',
  '  `customer_id` int NOT NULL,',
  "  `total` decimal(10,2) DEFAULT '0.00' COMMENT 'sum (net)',",
  '  PRIMARY KEY (`id`),',
  '  UNIQUE KEY `uq_c` (`customer_id`,`total`),',
  '  KEY `idx_c` (`customer_id`),',
  '  FULLTEXT KEY `ft` (`note`),',
  '  CONSTRAINT `fk_c` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE,',
  '  CONSTRAINT `fk_x` FOREIGN KEY (`id`) REFERENCES `other`.`x` (`id`),',
  '  CONSTRAINT `chk` CHECK ((`total` >= 0))',
  ") ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='o'"
].join('\n')

test('mysql: SHOW CREATE TABLE parsing', () => {
  const p = parseMysqlCreateTable(MY_CREATE)
  assert.deepEqual([...p.columns.keys()], ['id', 'customer_id', 'total'])
  assert.equal(p.columns.get('total'), "`total` decimal(10,2) DEFAULT '0.00' COMMENT 'sum (net)'")
  assert.equal(p.options, "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='o'")
  assert.deepEqual(p.constraints.map((c) => [c.kind, c.name, c.columns.join(), c.refTable ?? '', c.refSchema ?? '']), [
    ['pk', 'PRIMARY', 'id', '', ''], ['unique', 'uq_c', 'customer_id,total', '', ''], ['fk', 'fk_c', 'customer_id', 'customers', ''], ['fk', 'fk_x', 'id', 'x', 'other'], ['check', 'chk', '', '', '']
  ])
  assert.deepEqual(p.indexes.map((i) => [i.name, i.def]), [['idx_c', 'KEY `idx_c` (`customer_id`)'], ['ft', 'FULLTEXT KEY `ft` (`note`)']])
})

test('mysql: MODIFY / ADD AFTER, FK rebuild around a referenced type change, keys inline in CREATE', () => {
  const c = (name: string, type: string, rest = ''): Col => col(name, type, { def: `\`${name}\` ${type}${rest}`, nullable: !rest.includes('NOT NULL') })
  const mk = (idType: string, extra: Col[] = []): SS.SchemaModel => model({ tables: [
    table('a', [c('id', idType, ' NOT NULL'), ...extra], { constraints: [{ name: 'PRIMARY', kind: 'pk', def: 'PRIMARY KEY (`id`)', columns: ['id'] }] }),
    table('b', [c('a_id', idType)], { constraints: [{ name: 'fk_a', kind: 'fk', def: 'CONSTRAINT `fk_a` FOREIGN KEY (`a_id`) REFERENCES `a` (`id`)', columns: ['a_id'], refTable: 'a', refSchema: null, refColumns: ['id'] }], indexes: [{ name: 'fk_a', def: 'KEY `fk_a` (`a_id`)', unique: false, columns: ['a_id'] }] })
  ] }, 'mysql', 'shop2')
  const s = all(diffSchemas(mk('bigint', [c('name', 'varchar(20)')]), mk('int(11)'), opts()), 'mysql', 'shop2')
  assert.deepEqual(s, [
    'USE `shop2`;',
    'ALTER TABLE `shop2`.`b` DROP FOREIGN KEY `fk_a`;',
    'ALTER TABLE `shop2`.`a` ADD COLUMN `name` varchar(20) AFTER `id`;',
    'ALTER TABLE `shop2`.`a` MODIFY COLUMN `id` bigint NOT NULL;',
    'ALTER TABLE `shop2`.`b` MODIFY COLUMN `a_id` bigint;',
    'ALTER TABLE `shop2`.`b` ADD CONSTRAINT `fk_a` FOREIGN KEY (`a_id`) REFERENCES `a` (`id`);'
  ])
  // display width alone is not a difference
  assert.deepEqual(diffSchemas(mk('int'), mk('int(11)'), opts()).map((i) => i.op), ['same', 'same'])
  const created = all(diffSchemas(mk('int'), model({}, 'mysql', 'shop2'), opts()), 'mysql', 'shop2')
  assert.ok(created.includes('CREATE TABLE `shop2`.`b` (\n  `a_id` int,\n  KEY `fk_a` (`a_id`)\n);'), created.join('\n'))
})

test('mysql: routines drop and recreate; script wraps bodies in DELIMITER', () => {
  const p = (body: string): SS.SRoutine => ({ name: 'p', kind: 'procedure', args: '', result: null, def: `CREATE PROCEDURE \`p\`()\nBEGIN\n  ${body};\nEND` })
  const s = all(diffSchemas(model({ routines: [p('SELECT 2')] }, 'mysql'), model({ routines: [p('SELECT 1')] }, 'mysql'), opts()), 'mysql')
  assert.deepEqual(s.slice(1), ['DROP PROCEDURE IF EXISTS `app`.`p`;', 'CREATE PROCEDURE `p`()\nBEGIN\n  SELECT 2;\nEND;'])
  assert.equal(scriptText(s, 'mysql'), 'USE `app`;\n\nDROP PROCEDURE IF EXISTS `app`.`p`;\n\nDELIMITER $$\nCREATE PROCEDURE `p`()\nBEGIN\n  SELECT 2;\nEND$$\nDELIMITER ;\n')
  assert.equal(scriptText([], 'mysql'), '')
})

test('unchecked items leave the script; identical items have no statements', () => {
  const src = model({ tables: [table('a', [col('x', 'text')]), table('b', [col('y', 'text')]), table('c', [col('z', 'text')])] })
  const dst = model({ tables: [table('c', [col('z', 'text')])] })
  const items = diffSchemas(src, dst, opts())
  assert.deepEqual(items.map((i) => [i.id, i.op, i.stmts.length]), [['table:a', 'create', 1], ['table:b', 'create', 1], ['table:c', 'same', 0]])
  const s = buildScript(items, (id) => id !== 'table:a', { dialect: 'postgres', schema: 'app' })
  assert.deepEqual(s, ['SET search_path TO "app";', 'CREATE TABLE "app"."b" (\n  "y" text\n);'])
})

test('topo puts dependencies first and survives cycles', () => {
  const deps: Record<string, string[]> = { a: ['b'], b: ['c'], c: [], x: ['y'], y: ['x'] }
  assert.deepEqual(topo(['a', 'b', 'c'], (n) => deps[n]), ['c', 'b', 'a'])
  assert.deepEqual(topo(['x', 'y'], (n) => deps[n]).sort(), ['x', 'y'])
})

test('line diff pairs changes and keeps line numbers', () => {
  const rows = lineDiff('a\nb\nc\nd', 'a\nB\nc\ne\nf')
  assert.deepEqual(rows.map((r) => [r.kind, r.left, r.right, r.ln, r.rn]), [
    ['same', 'a', 'a', 1, 1], ['change', 'b', 'B', 2, 2], ['same', 'c', 'c', 3, 3], ['change', 'd', 'e', 4, 4], ['dst', null, 'f', null, 5]
  ])
  assert.deepEqual(lineDiff('x', '').map((r) => r.kind), ['src'])
  assert.deepEqual(lineDiff('', ''), [])
})
