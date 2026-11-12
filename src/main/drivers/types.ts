import type { Column, DbObject, Dialect, ForeignKey, Index, Result, Trigger, DbUser, TableStat } from '@shared/types'

export interface ConnectParams {
  host: string
  port: number
  user?: string
  password?: string
  database?: string
  filePath?: string
  ssl?: { mode: string; ca?: string; cert?: string; key?: string }
}

export interface SqlDriver {
  dialect: Dialect
  connect(): Promise<void>
  close(): Promise<void>
  ping(): Promise<void>
  serverVersion(): Promise<string>
  currentDatabase(): string | undefined
  databases(): Promise<string[]>
  useDatabase(name: string): Promise<void>
  createDatabase(name: string, encoding?: string, collation?: string): Promise<void>
  schemas(system?: boolean): Promise<string[]>
  defaultSchema(): string
  objects(schema: string): Promise<DbObject[]>
  columns(schema: string, table: string): Promise<Column[]>
  indexes(schema: string, table: string): Promise<Index[]>
  foreignKeys(schema: string, table: string): Promise<ForeignKey[]>
  triggers(schema: string, table: string): Promise<Trigger[]>
  ddl(schema: string, name: string, kind: string): Promise<string>
  estimateCount(schema: string, table: string): Promise<number | null>
  tableStats(schema: string): Promise<TableStat[]>
  /** The table a reference in a query names, resolved the way the server does (search path, case, quoting). */
  resolveTable(ref: { schema?: string; table: string; raw: string }): Promise<{ schema: string; table: string } | null>
  query(sql: string): Promise<Result>
  /** Make unqualified names in the editor resolve in this schema first (Postgres search_path). */
  useSchema?(schema: string): Promise<void>
  cancel(): Promise<void>
  processes(): Promise<Result>
  kill(id: string): Promise<string>
  users(): Promise<DbUser[]>
  userGrants(name: string, host?: string): Promise<{ scope: string; privileges: string[] }[]>
}

/** Make driver values IPC/grid friendly: strings for big numbers, dates, binaries and objects. */
export function cell(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString()
  if (v instanceof Uint8Array) return '\\x' + Buffer.from(v).toString('hex')
  if (typeof v === 'object') return JSON.stringify(v)
  return v
}

export const rowsOut = (rows: unknown[][]): unknown[][] => rows.map((r) => r.map(cell))
