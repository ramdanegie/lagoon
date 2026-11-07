// User management RPC (PostgreSQL, MySQL/MariaDB): full user state, grant targets, and Apply.
import { register } from './rpc'
import { session, sqlDriver } from './sessions'
import { addHistory } from './store'
import type { SqlDriver } from './drivers/types'
import { PG_ROLES_SQL, PG_GRANTS_SQL, PG_TABLES_SQL, MYSQL_USERS_SQL, MYSQL_DB_SQL, parsePgUsers, parseMysqlUsers, redactSql, type UserState } from '@shared/usersql'

register({
  /** Every user with its attributes, limits and grants, so the renderer can diff edits against it. */
  'users.list': async (_c, s: string): Promise<UserState[]> => {
    const d = sqlDriver(s)
    if (d.dialect === 'postgres') return parsePgUsers(await d.query(PG_ROLES_SQL), await d.query(PG_GRANTS_SQL))
    if (d.dialect === 'mysql') return parseMysqlUsers(await d.query(MYSQL_USERS_SQL), await d.query(MYSQL_DB_SQL))
    throw new Error('User management needs PostgreSQL, MySQL or MariaDB.')
  },
  /** What privileges can be granted on: PostgreSQL tables of the current database, MySQL databases. */
  'users.targets': async (_c, s: string): Promise<{ schema: string; table: string }[]> => {
    const d = sqlDriver(s)
    if (d.dialect === 'mysql') return (await d.databases()).map((schema) => ({ schema, table: '' }))
    return (await d.query(PG_TABLES_SQL)).rows.map(([schema, table]) => ({ schema: String(schema), table: String(table) }))
  },
  /** Run one user's statements in order and stop at the first error. Passwords are masked in history and the console. */
  'users.apply': async (_c, s: string, stmts: string[]): Promise<{ ok: boolean; index?: number; error?: string }> => {
    const conn = session(s).conn
    const d = sqlDriver(s) as SqlDriver & { onSql: (sql: string) => void }
    const log = d.onSql
    d.onSql = (sql) => log(redactSql(sql))
    try {
      for (let i = 0; i < stmts.length; i++) {
        const t = Date.now()
        const entry = { connectionId: conn.id, database: d.currentDatabase(), sql: redactSql(stmts[i]), source: 'user_mgmt' }
        try {
          await d.query(stmts[i])
          addHistory({ ...entry, durationMs: Date.now() - t })
        } catch (e) {
          const error = (e as Error).message
          addHistory({ ...entry, durationMs: Date.now() - t, error })
          return { ok: false, index: i, error }
        }
      }
      return { ok: true }
    } finally {
      d.onSql = log
    }
  }
})
