export type DriverId = 'postgres' | 'mysql' | 'mariadb' | 'sqlite' | 'redis' | 'mongodb'
export type Dialect = 'postgres' | 'mysql' | 'sqlite'
export type PasswordMode = 'store' | 'ask' | 'none' | 'command'

export const SAFE_MODES = ['Silent', 'Alert 1', 'Alert 2', 'Safe 1', 'Safe 2'] as const

export interface SshConfig {
  enabled: boolean
  host: string
  port: number
  user: string
  useKey: boolean
  keyPath?: string
  passwordMode: PasswordMode
}

export interface SslConfig {
  mode: string // per-driver list, see SSL_MODES
  keyPath?: string
  certPath?: string
  caPath?: string
}

export interface ConnectionOptions {
  rowLimit?: number | null
  pgDumpPath?: string
  mysqldumpPath?: string
  backupOptions?: string
  restoreOptions?: string
  encoding?: string
  /** databases listed in the connection tree; unset = all */
  databases?: string[]
}

export interface Connection {
  id: string
  name: string
  driver: DriverId
  host?: string
  port?: number
  username?: string
  database?: string
  filePath?: string
  passwordMode: PasswordMode
  passwordCommand?: string
  statusColor?: string
  tagId?: string | null
  groupId?: string | null
  safeMode: number
  bootstrapSql?: string
  ssh?: SshConfig
  ssl?: SslConfig
  options?: ConnectionOptions
  sortOrder?: number
  // secrets only travel renderer -> main on save; main never returns them
  password?: string
  sshPassword?: string
  sshPassphrase?: string
}

export interface Tag { id: string; name: string; color: string; builtin: boolean }
export interface Group { id: string; name: string; icon?: string; parentId?: string | null; sortOrder: number }

export const DRIVERS: { id: DriverId; name: string; port?: number; dialect?: Dialect; short: string }[] = [
  { id: 'postgres', name: 'PostgreSQL', port: 5432, dialect: 'postgres', short: 'Pg' },
  { id: 'mysql', name: 'MySQL', port: 3306, dialect: 'mysql', short: 'My' },
  { id: 'mariadb', name: 'MariaDB', port: 3306, dialect: 'mysql', short: 'Ma' },
  { id: 'sqlite', name: 'SQLite', dialect: 'sqlite', short: 'Sl' },
  { id: 'redis', name: 'Redis', port: 6379, short: 'Rd' },
  { id: 'mongodb', name: 'MongoDB', port: 27017, short: 'Mg' }
]

export const SSL_MODES: Partial<Record<DriverId, string[]>> = {
  postgres: ['PREFERRED', 'DISABLED', 'REQUIRED', 'ALLOW', 'VERIFY-CA', 'VERIFY-FULL'],
  mysql: ['PREFERRED', 'DISABLED', 'REQUIRED', 'VERIFY-CA', 'VERIFY-IDENTITY'],
  mariadb: ['PREFERRED', 'DISABLED', 'REQUIRED', 'VERIFY-CA', 'VERIFY-IDENTITY'],
  redis: ['DISABLED', 'REQUIRED'],
  mongodb: ['DISABLED', 'REQUIRED']
}

export const dialectOf = (d: DriverId): Dialect | undefined => DRIVERS.find((x) => x.id === d)?.dialect

export type ObjectKind = 'table' | 'view' | 'matview' | 'function' | 'procedure' | 'sequence' | 'collection' | 'key'

export interface DbObject { schema: string; name: string; kind: ObjectKind }

/** A Pub/Sub message (channel, pattern, message) or a MONITOR line (args, source, db). */
export interface RedisLiveEvent { at: number; channel?: string; pattern?: string; message?: string; args?: string[]; source?: string; db?: number }

/** One row of the tables overview. Sizes in bytes; rows are the server's estimate (exact for SQLite). */
export interface TableStat { name: string; kind: ObjectKind; rows: number | null; data: number | null; index: number | null; comment: string | null }

export interface Column {
  name: string
  type: string
  nullable: boolean
  default: string | null
  pk: boolean
  comment?: string | null
  ordinal: number
  extra?: string | null
}

export interface Index { name: string; columns: string[]; unique: boolean; primary: boolean; type?: string; condition?: string | null }

export interface ForeignKey {
  name: string
  columns: string[]
  refSchema: string
  refTable: string
  refColumns: string[]
  onUpdate: string
  onDelete: string
}

export interface Trigger { name: string; timing: string; event: string; statement: string }

export interface ResultColumn { name: string; type?: string; table?: string }

export interface Result {
  columns: ResultColumn[]
  rows: unknown[][]
  rowCount: number
  affected?: number | null
  notices?: string[]
  ms: number
  sql: string
  error?: string
  command?: string
}

export type FilterOp =
  | '=' | '<>' | '<' | '>' | '<=' | '>='
  | 'IN' | 'NOT IN' | 'IS NULL' | 'IS NOT NULL' | 'BETWEEN' | 'NOT BETWEEN'
  | 'LIKE' | 'ILIKE' | 'Contains' | 'Not contains' | 'Has prefix' | 'Has suffix'
  | 'Contains (ci)' | 'Not contains (ci)' | 'Has prefix (ci)' | 'Has suffix (ci)'
  | 'IS EMPTY' | 'IS NOT EMPTY'

export interface Filter {
  id: string
  enabled: boolean
  column: string // column name | '__any__' | '__raw__'
  op: FilterOp
  value: string
  not?: boolean // wrap the condition in NOT (…)
}

export interface SortSpec { column: string; dir: 'ASC' | 'DESC' }

export interface TableQuery {
  schema: string
  table: string
  filters: Filter[]
  join: 'AND' | 'OR'
  sort: SortSpec[]
  limit: number
  offset: number
  columns?: string[] // visible subset (always fetch pk too)
}

export interface ServerInfo { version: string; dialect?: Dialect; database?: string; schema?: string }

export interface HistoryEntry {
  id: number
  connectionId: string
  database?: string
  sql: string
  source: string
  durationMs?: number
  error?: string
  executedAt: string
}

export interface DbUser {
  name: string
  host?: string
  superuser?: boolean
  canCreateDb?: boolean
  canCreateRole?: boolean
  replication?: boolean
  bypassRls?: boolean
  canLogin?: boolean
  maxQueries?: number
  maxUpdates?: number
  maxConnections?: number
  globalPrivs?: string[]
}

export interface JobProgress { id: string; kind: string; title: string; progress: number; state: 'running' | 'done' | 'failed' | 'cancelled'; message?: string; output?: string }
