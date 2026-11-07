import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import type * as UserSql from '../src/shared/usersql.ts'

// usersql imports './sqlgen' without an extension (the bundler resolves it); teach Node to try .ts
register('data:text/javascript,' + encodeURIComponent('export async function resolve(s, c, next) { try { return await next(s, c) } catch (e) { if (s.startsWith(".") && !s.endsWith(".ts")) return next(s + ".ts", c); throw e } }'))
const { userSql, parsePgUsers, parseMysqlUsers, privOfColumn, redactSql, blankUser }: typeof UserSql = await import('../src/shared/usersql.ts')

const pgUser = (over: Partial<UserSql.UserState> = {}): UserSql.UserState => ({ ...blankUser('postgres'), name: 'analyst', ...over })
const myUser = (over: Partial<UserSql.UserState> = {}): UserSql.UserState => ({ ...blankUser('mysql'), name: 'app', host: '%', ...over })

test('postgres create, alter, drop', () => {
  assert.deepEqual(userSql('postgres', null, pgUser({ global: ['CREATEDB', 'SUPERUSER'], scoped: [{ schema: 'public', table: 'orders', privs: ['SELECT', 'INSERT'] }] }), "p'w"), [
    `CREATE ROLE "analyst" WITH LOGIN SUPERUSER CREATEDB PASSWORD 'p''w';`,
    'GRANT SELECT, INSERT ON TABLE "public"."orders" TO "analyst";'
  ])
  const before = pgUser({ global: ['SUPERUSER'], scoped: [{ schema: 'public', table: 'orders', privs: ['SELECT', 'DELETE'] }] })
  const after = pgUser({ name: 'an"alyst', canLogin: false, global: ['REPLICATION'], scoped: [{ schema: 'public', table: 'orders', privs: ['SELECT', 'UPDATE'] }, { schema: 's', table: 't', privs: ['TRUNCATE'] }] })
  assert.deepEqual(userSql('postgres', before, after), [
    'ALTER ROLE "analyst" RENAME TO "an""alyst";',
    'ALTER ROLE "an""alyst" WITH NOLOGIN NOSUPERUSER REPLICATION;',
    'REVOKE DELETE ON TABLE "public"."orders" FROM "an""alyst";',
    'GRANT UPDATE ON TABLE "public"."orders" TO "an""alyst";',
    'GRANT TRUNCATE ON TABLE "s"."t" TO "an""alyst";'
  ])
  assert.deepEqual(userSql('postgres', before, before), [])
  assert.deepEqual(userSql('postgres', before, before, 'x'), [`ALTER ROLE "analyst" WITH PASSWORD 'x';`])
  assert.deepEqual(userSql('postgres', before, null), ['REVOKE ALL ON TABLE "public"."orders" FROM "analyst";', 'DROP ROLE "analyst";'])
  assert.deepEqual(userSql('postgres', null, null), [])
  // unknown attributes never reach the SQL
  assert.deepEqual(userSql('postgres', null, pgUser({ global: ['LOGIN; DROP TABLE x'] })), ['CREATE ROLE "analyst" WITH LOGIN;'])
})

test('mysql create, alter, drop', () => {
  assert.deepEqual(userSql('mysql', null, myUser({ host: 'localhost', maxQueries: 10, global: ['SELECT', 'GRANT OPTION'], scoped: [{ schema: 'shop', table: '', privs: ['INSERT'] }] }), "a'b\\c"), [
    `CREATE USER 'app'@'localhost' IDENTIFIED BY 'a''b\\\\c' WITH MAX_QUERIES_PER_HOUR 10;`,
    "GRANT SELECT ON *.* TO 'app'@'localhost' WITH GRANT OPTION;",
    "GRANT INSERT ON `shop`.* TO 'app'@'localhost';"
  ])
  const before = myUser({ global: ['SELECT', 'GRANT OPTION'], scoped: [{ schema: 'shop', table: '', privs: ['INSERT'] }] })
  const after = myUser({ host: '10.0.0.%', maxUpdates: 5, global: ['SELECT'], scoped: [{ schema: 'crm', table: '', privs: ['GRANT OPTION'] }] })
  assert.deepEqual(userSql('mysql', before, after, 'n'), [
    "RENAME USER 'app'@'%' TO 'app'@'10.0.0.%';",
    "ALTER USER 'app'@'10.0.0.%' IDENTIFIED BY 'n';",
    "ALTER USER 'app'@'10.0.0.%' WITH MAX_UPDATES_PER_HOUR 5;",
    "REVOKE GRANT OPTION ON *.* FROM 'app'@'10.0.0.%';",
    "REVOKE INSERT ON `shop`.* FROM 'app'@'10.0.0.%';",
    "GRANT USAGE ON `crm`.* TO 'app'@'10.0.0.%' WITH GRANT OPTION;"
  ])
  assert.deepEqual(userSql('mysql', before, null), ["DROP USER 'app'@'%';"])
  assert.throws(() => userSql('mysql', null, myUser({ host: '' })), /host/)
  assert.throws(() => userSql('mysql', null, myUser({ name: ' ' })), /name/)
  assert.throws(() => userSql('mysql', null, myUser({ global: ['SELECT; DROP'] })), /Unknown privilege/)
})

test('catalog parsing', () => {
  const pg = parsePgUsers(
    { columns: ['rolname', 'rolcanlogin', 'rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls'].map((name) => ({ name })), rows: [['a', true, false, true, false, false, true], ['b', false, false, false, false, false, false]] },
    { columns: ['rolname', 'nspname', 'relname', 'privilege_type'].map((name) => ({ name })), rows: [['a', 'public', 't', 'SELECT'], ['a', 'public', 't', 'INSERT'], ['zz', 'public', 't', 'SELECT']] }
  )
  assert.deepEqual(pg.map((u) => [u.name, u.canLogin, u.global, u.scoped]), [['a', true, ['CREATEDB', 'BYPASSRLS'], [{ schema: 'public', table: 't', privs: ['SELECT', 'INSERT'] }]], ['b', false, [], []]])
  const my = parseMysqlUsers(
    { columns: ['Host', 'User', 'Select_priv', 'Grant_priv', 'Create_tmp_table_priv', 'authentication_string', 'max_questions', 'max_updates', 'max_connections'].map((name) => ({ name })), rows: [['%', 'app', 'Y', 'Y', 'N', 'hash', '3', '0', '7']] },
    { columns: ['Host', 'Db', 'User', 'Select_priv', 'Show_view_priv'].map((name) => ({ name })), rows: [['%', 'shop', 'app', 'Y', 'Y'], ['%', 'none', 'app', 'N', 'N']] }
  )
  assert.deepEqual(my, [{ name: 'app', host: '%', canLogin: true, global: ['SELECT', 'GRANT OPTION'], scoped: [{ schema: 'shop', table: '', privs: ['SELECT', 'SHOW VIEW'] }], maxQueries: 3, maxUpdates: 0, maxConnections: 7 }])
  assert.equal(privOfColumn('Create_routine_priv'), 'CREATE ROUTINE')
  assert.equal(privOfColumn('Repl_slave_priv'), 'REPLICATION SLAVE')
  assert.equal(privOfColumn('max_questions'), null)
})

test('redact passwords', () => {
  assert.equal(redactSql(`CREATE ROLE "a" WITH LOGIN PASSWORD 'it''s';`), `CREATE ROLE "a" WITH LOGIN PASSWORD '********';`)
  assert.equal(redactSql(`ALTER USER 'a'@'%' IDENTIFIED BY 'x\\'y';`), `ALTER USER 'a'@'%' IDENTIFIED BY '********';`)
  assert.equal(redactSql('GRANT SELECT ON *.* TO x;'), 'GRANT SELECT ON *.* TO x;')
})
