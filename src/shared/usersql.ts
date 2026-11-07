// User management SQL for PostgreSQL and MySQL/MariaDB: catalog reads (main) and the
// CREATE / ALTER / DROP / GRANT / REVOKE statements Apply sends (renderer). Pure, no runtime deps but sqlgen.
import type { Dialect } from './types'
import { qi, qt, lit } from './sqlgen'

/** PostgreSQL: privileges on schema.table. MySQL: privileges on a whole database (table is ''). */
export interface Grant { schema: string; table: string; privs: string[] }

export interface UserState {
  name: string
  host: string // MySQL/MariaDB account host; '' on PostgreSQL
  canLogin: boolean // PostgreSQL LOGIN
  global: string[] // PostgreSQL role attributes, or MySQL global privileges
  scoped: Grant[] // PostgreSQL table privileges, or MySQL database privileges
  maxQueries: number
  maxUpdates: number
  maxConnections: number
}

export const PG_ATTRS: [string, string][] = [
  ['SUPERUSER', 'Superuser'],
  ['CREATEDB', 'Create databases'],
  ['CREATEROLE', 'Create roles'],
  ['REPLICATION', 'Replication'],
  ['BYPASSRLS', 'Bypass row-level security']
]
export const PG_TABLE_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']

export const MYSQL_GLOBAL_GROUPS: [string, string[]][] = [
  ['Data & tables', ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'REFERENCES', 'CREATE TEMPORARY TABLES', 'LOCK TABLES', 'TRIGGER']],
  ['Views & routines', ['CREATE VIEW', 'SHOW VIEW', 'CREATE ROUTINE', 'ALTER ROUTINE', 'EXECUTE', 'EVENT']],
  ['Administration', ['RELOAD', 'SHUTDOWN', 'PROCESS', 'FILE', 'SHOW DATABASES', 'SUPER', 'REPLICATION SLAVE', 'REPLICATION CLIENT', 'CREATE USER', 'GRANT OPTION']]
]
export const MYSQL_DB_PRIVS = [...MYSQL_GLOBAL_GROUPS[0][1], ...MYSQL_GLOBAL_GROUPS[1][1], 'GRANT OPTION']

export const blankUser = (d: Dialect): UserState => ({ name: '', host: d === 'mysql' ? '%' : '', canLogin: true, global: [], scoped: [], maxQueries: 0, maxUpdates: 0, maxConnections: 0 })
export const userKey = (u: Pick<UserState, 'name' | 'host'>): string => `${u.name}@${u.host}`
export const scopeKey = (g: Pick<Grant, 'schema' | 'table'>): string => `${g.schema}\u0000${g.table}`

// ---------- reading the catalog ----------

export const PG_ROLES_SQL = `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY 1`
// aclexplode sees every grant, whoever the grantor (information_schema only shows grants involving the current role)
export const PG_GRANTS_SQL = `SELECT r.rolname, n.nspname, c.relname, a.privilege_type FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid = a.grantee WHERE c.relkind IN ('r','p','v','m','f') ORDER BY 1, 2, 3, 4`
export const PG_TABLES_SQL = `SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' ORDER BY 1, 2`
// SELECT * because privilege columns differ across MySQL/MariaDB versions; password hashes never leave main
export const MYSQL_USERS_SQL = 'SELECT * FROM mysql.user'
export const MYSQL_DB_SQL = 'SELECT * FROM mysql.db'

interface Rows { columns: { name: string }[]; rows: unknown[][] }
const objects = (r: Rows): Record<string, unknown>[] => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name, row[i]])))
const truthy = (v: unknown): boolean => v === true || v === 't' || v === 'true' || v === 1 || v === '1'

const MYSQL_COL: Record<string, string> = { Create_tmp_table_priv: 'CREATE TEMPORARY TABLES', Show_db_priv: 'SHOW DATABASES', Repl_slave_priv: 'REPLICATION SLAVE', Repl_client_priv: 'REPLICATION CLIENT', Grant_priv: 'GRANT OPTION' }
/** mysql.user / mysql.db column → privilege name (Create_view_priv → CREATE VIEW); null for non-privilege columns. */
export const privOfColumn = (col: string): string | null => (/^[A-Za-z_]+_priv$/.test(col) ? MYSQL_COL[col] ?? col.slice(0, -5).replace(/_/g, ' ').toUpperCase() : null)
const privsOf = (row: Record<string, unknown>): string[] => Object.keys(row).filter((k) => row[k] === 'Y').map(privOfColumn).filter((p): p is string => !!p)

export function parsePgUsers(roles: Rows, grants: Rows): UserState[] {
  const users = objects(roles).map((r): UserState => ({
    ...blankUser('postgres'),
    name: String(r.rolname),
    canLogin: truthy(r.rolcanlogin),
    global: PG_ATTRS.filter((_a, i) => truthy([r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls][i])).map(([a]) => a)
  }))
  const byName = new Map(users.map((u) => [u.name, u]))
  for (const g of objects(grants)) {
    const u = byName.get(String(g.rolname))
    if (!u) continue
    const scope = { schema: String(g.nspname), table: String(g.relname) }
    let hit = u.scoped.find((x) => scopeKey(x) === scopeKey(scope))
    if (!hit) u.scoped.push((hit = { ...scope, privs: [] }))
    if (!hit.privs.includes(String(g.privilege_type))) hit.privs.push(String(g.privilege_type))
  }
  return users
}

export function parseMysqlUsers(users: Rows, dbs: Rows): UserState[] {
  const out = objects(users)
    .filter((r) => r.is_role !== 'Y') // MariaDB roles live in mysql.user too
    .map((r): UserState => ({
      ...blankUser('mysql'),
      name: String(r.User ?? r.user),
      host: String(r.Host ?? r.host),
      global: privsOf(r),
      maxQueries: Number(r.max_questions ?? 0),
      maxUpdates: Number(r.max_updates ?? 0),
      maxConnections: Number(r.max_connections ?? 0)
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.host.localeCompare(b.host))
  const byKey = new Map(out.map((u) => [userKey(u), u]))
  for (const r of objects(dbs)) {
    const u = byKey.get(userKey({ name: String(r.User), host: String(r.Host) }))
    const privs = privsOf(r)
    if (u && privs.length) u.scoped.push({ schema: String(r.Db), table: '', privs })
  }
  return out
}

// ---------- statements ----------

const PRIV = /^[A-Z][A-Z ]*$/
function privList(p: string[]): string {
  for (const x of p) if (!PRIV.test(x)) throw new Error(`Unknown privilege "${x}"`)
  return p.join(', ')
}

/** Who a statement targets: "name" on PostgreSQL, 'name'@'host' on MySQL. */
export const account = (d: Dialect, u: Pick<UserState, 'name' | 'host'>): string => (d === 'mysql' ? `${lit(d, u.name)}@${lit(d, u.host || '%')}` : qi(d, u.name))

const limit = (n: number): number => Math.max(0, Math.floor(Number(n) || 0))
const LIMITS: [keyof UserState, string][] = [['maxQueries', 'MAX_QUERIES_PER_HOUR'], ['maxUpdates', 'MAX_UPDATES_PER_HOUR'], ['maxConnections', 'MAX_CONNECTIONS_PER_HOUR']]

function privDiff(d: Dialect, before: string[], after: string[], on: string, who: string): string[] {
  const out: string[] = []
  const gone = before.filter((p) => !after.includes(p))
  const added = after.filter((p) => !before.includes(p))
  if (gone.length) out.push(`REVOKE ${privList(gone)} ON ${on} FROM ${who};`)
  if (added.length) {
    // MySQL grants GRANT OPTION through WITH GRANT OPTION, not in the privilege list
    const go = d === 'mysql' && added.includes('GRANT OPTION')
    const rest = added.filter((p) => !(go && p === 'GRANT OPTION'))
    out.push(`GRANT ${rest.length ? privList(rest) : 'USAGE'} ON ${on} TO ${who}${go ? ' WITH GRANT OPTION' : ''};`)
  }
  return out
}

/**
 * Statements turning `before` into `after`. before null = new user, after null = delete.
 * `password` '' leaves the password unchanged. PostgreSQL and MySQL/MariaDB only.
 */
export function userSql(d: Dialect, before: UserState | null, after: UserState | null, password = ''): string[] {
  if (d === 'sqlite') throw new Error('SQLite has no users.')
  if (!before && !after) return []
  if (!after) {
    if (d === 'mysql') return [`DROP USER ${account(d, before!)};`]
    // PostgreSQL refuses to drop a role that still holds privileges; objects it owns still block (on purpose)
    return [...before!.scoped.map((g) => `REVOKE ALL ON TABLE ${qt(d, g.schema, g.table)} FROM ${account(d, before!)};`), `DROP ROLE ${account(d, before!)};`]
  }
  if (!after.name.trim()) throw new Error('A user needs a name.')
  const out: string[] = []
  const who = account(d, after)
  const pw = password ? lit(d, password) : ''
  if (d === 'postgres') {
    const attrs = PG_ATTRS.map(([a]) => a).filter((a) => after.global.includes(a))
    if (!before) out.push(`CREATE ROLE ${who} WITH ${[after.canLogin ? 'LOGIN' : 'NOLOGIN', ...attrs].join(' ')}${pw ? ` PASSWORD ${pw}` : ''};`)
    else {
      if (before.name !== after.name) out.push(`ALTER ROLE ${account(d, before)} RENAME TO ${who};`)
      const opts = PG_ATTRS.map(([a]) => a).filter((a) => before.global.includes(a) !== after.global.includes(a)).map((a) => (after.global.includes(a) ? a : `NO${a}`))
      if (before.canLogin !== after.canLogin) opts.unshift(after.canLogin ? 'LOGIN' : 'NOLOGIN')
      if (pw) opts.push(`PASSWORD ${pw}`)
      if (opts.length) out.push(`ALTER ROLE ${who} WITH ${opts.join(' ')};`)
    }
  } else {
    if (!after.host.trim()) throw new Error('A MySQL user needs a host (use % for any host).')
    if (!before) {
      const lim = LIMITS.filter(([k]) => limit(after[k] as number) > 0).map(([k, kw]) => `${kw} ${limit(after[k] as number)}`)
      out.push(`CREATE USER ${who}${pw ? ` IDENTIFIED BY ${pw}` : ''}${lim.length ? ` WITH ${lim.join(' ')}` : ''};`)
    } else {
      if (before.name !== after.name || before.host !== after.host) out.push(`RENAME USER ${account(d, before)} TO ${who};`)
      if (pw) out.push(`ALTER USER ${who} IDENTIFIED BY ${pw};`)
      const lim = LIMITS.filter(([k]) => limit(before[k] as number) !== limit(after[k] as number)).map(([k, kw]) => `${kw} ${limit(after[k] as number)}`)
      if (lim.length) out.push(`ALTER USER ${who} WITH ${lim.join(' ')};`)
    }
    out.push(...privDiff(d, before?.global ?? [], after.global, '*.*', who))
  }
  const was = new Map((before?.scoped ?? []).map((g) => [scopeKey(g), g]))
  const now = new Map(after.scoped.map((g) => [scopeKey(g), g]))
  for (const k of new Set([...was.keys(), ...now.keys()])) {
    const g = (now.get(k) ?? was.get(k))!
    const on = d === 'mysql' ? `${qi(d, g.schema)}.*` : `TABLE ${qt(d, g.schema, g.table)}`
    out.push(...privDiff(d, was.get(k)?.privs ?? [], now.get(k)?.privs ?? [], on, who))
  }
  return out
}

/** Hide password literals before SQL is shown or stored in history. */
export const redactSql = (sql: string): string => sql.replace(/\b(PASSWORD|IDENTIFIED BY) '(?:[^'\\]|''|\\.)*'/g, "$1 '********'")
