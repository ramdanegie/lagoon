// Dialect-aware SQL builders. Shared by main (execution) and renderer (Preview shows the exact SQL).
// Kept free of runtime imports so `node --test` can load it directly.
import type { Dialect, Filter, TableQuery, Column, ForeignKey, Index } from './types'

/** A cell value. `{ raw }` is inserted verbatim (DEFAULT, NOW(), CURRENT_TIMESTAMP). */
export type CellValue = string | number | boolean | null | { raw: string }

export const qi = (d: Dialect, name: string): string =>
  d === 'mysql' ? '`' + name.replace(/`/g, '``') + '`' : '"' + name.replace(/"/g, '""') + '"'

export const qt = (d: Dialect, schema: string | undefined, table: string): string =>
  schema && d !== 'sqlite' ? `${qi(d, schema)}.${qi(d, table)}` : qi(d, table)

const NUMERIC = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/

export function lit(d: Dialect, v: CellValue, type?: string): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'object') return v.raw
  if (typeof v === 'boolean') return d === 'postgres' ? (v ? 'TRUE' : 'FALSE') : v ? '1' : '0'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (type && isNumericType(type) && NUMERIC.test(v.trim())) return v.trim()
  let s = v.replace(/'/g, "''")
  if (d === 'mysql') s = s.replace(/\\/g, '\\\\')
  return `'${s}'`
}

export const isNumericType = (t: string): boolean =>
  /^(small|big|tiny|medium)?int|integer|serial|numeric|decimal|real|double|float|number/i.test(t.trim())

const textCast = (d: Dialect, col: string): string => (d === 'postgres' ? `CAST(${col} AS TEXT)` : d === 'mysql' ? `CAST(${col} AS CHAR)` : col)

function cond(d: Dialect, col: string, f: Filter, type: string | undefined, anyCol: boolean): string {
  const c = anyCol ? textCast(d, col) : col
  const t = anyCol ? undefined : type
  const v = f.value
  const like = (pat: string, not = false, ci = false): string => {
    const op = ci ? (d === 'postgres' ? 'ILIKE' : 'LIKE') : 'LIKE'
    const target = ci && d !== 'postgres' ? `LOWER(${c})` : d === 'postgres' ? textCast(d, col) : c
    const p = ci && d !== 'postgres' ? pat.toLowerCase() : pat
    return `${target} ${not ? 'NOT ' : ''}${op} ${lit(d, p)}`
  }
  switch (f.op) {
    case 'IS NULL': return `${col} IS NULL`
    case 'IS NOT NULL': return `${col} IS NOT NULL`
    case 'IN':
    case 'NOT IN': {
      const items = v.split(',').map((x) => x.trim()).filter((x) => x !== '')
      if (!items.length) return f.op === 'IN' ? '1=0' : '1=1'
      return `${c} ${f.op} (${items.map((x) => lit(d, unquote(x), t)).join(', ')})`
    }
    case 'BETWEEN':
    case 'NOT BETWEEN': {
      const [a, b] = v.split(/\s+and\s+/i)
      return `${c} ${f.op} ${lit(d, unquote(a ?? ''), t)} AND ${lit(d, unquote(b ?? ''), t)}`
    }
    case 'LIKE': return `${d === 'postgres' ? textCast(d, col) : c} LIKE ${lit(d, v)}`
    case 'ILIKE': return like(v, false, true)
    case 'Contains': return like(`%${v}%`)
    case 'Not contains': return like(`%${v}%`, true)
    case 'Has prefix': return like(`${v}%`)
    case 'Has suffix': return like(`%${v}`)
    case 'Contains (ci)': return like(`%${v}%`, false, true)
    case 'Not contains (ci)': return like(`%${v}%`, true, true)
    case 'Has prefix (ci)': return like(`${v}%`, false, true)
    case 'Has suffix (ci)': return like(`%${v}`, false, true)
    default: return `${c} ${f.op} ${lit(d, v, t)}`
  }
}

const unquote = (s: string): string => (/^'.*'$/.test(s) ? s.slice(1, -1).replace(/''/g, "'") : s)

export function filterSql(d: Dialect, f: Filter, columns: Pick<Column, 'name' | 'type'>[]): string {
  if (f.column === '__raw__') return f.value.trim() ? `(${f.value})` : ''
  if (f.column === '__any__') {
    if (f.op === 'IS NULL' || f.op === 'IS NOT NULL')
      return `(${columns.map((c) => `${qi(d, c.name)} ${f.op}`).join(' OR ')})`
    return `(${columns.map((c) => cond(d, qi(d, c.name), f, c.type, true)).join(' OR ')})`
  }
  const col = columns.find((c) => c.name === f.column)
  return cond(d, qi(d, f.column), f, col?.type, false)
}

export function whereSql(d: Dialect, filters: Filter[], join: 'AND' | 'OR', columns: Pick<Column, 'name' | 'type'>[]): string {
  const parts = filters.filter((f) => f.enabled).map((f) => filterSql(d, f, columns)).filter(Boolean)
  return parts.length ? ` WHERE ${parts.join(` ${join} `)}` : ''
}

export function selectSql(d: Dialect, q: TableQuery, columns: Pick<Column, 'name' | 'type'>[]): string {
  const cols = q.columns?.length ? q.columns.map((c) => qi(d, c)).join(', ') : '*'
  const order = q.sort.length ? ` ORDER BY ${q.sort.map((s) => `${qi(d, s.column)} ${s.dir}`).join(', ')}` : ''
  return `SELECT ${cols} FROM ${qt(d, q.schema, q.table)}${whereSql(d, q.filters, q.join, columns)}${order} LIMIT ${q.limit} OFFSET ${q.offset}`
}

export const countSql = (d: Dialect, q: TableQuery, columns: Pick<Column, 'name' | 'type'>[]): string =>
  `SELECT COUNT(*) FROM ${qt(d, q.schema, q.table)}${whereSql(d, q.filters, q.join, columns)}`

/** WHERE clause that identifies one row. Uses key columns, or every column when the table has no key. */
export function keyWhere(d: Dialect, key: Record<string, CellValue>, types: Record<string, string> = {}): string {
  return Object.entries(key)
    .map(([k, v]) => (v === null ? `${qi(d, k)} IS NULL` : `${qi(d, k)} = ${lit(d, v, types[k])}`))
    .join(' AND ')
}

export function updateSql(d: Dialect, schema: string, table: string, key: Record<string, CellValue>, changes: Record<string, CellValue>, types: Record<string, string> = {}, keyIsUnique = true): string {
  const set = Object.entries(changes).map(([k, v]) => `${qi(d, k)} = ${lit(d, v, types[k])}`).join(', ')
  // shortcut: without a unique key MySQL/SQLite-style LIMIT 1 keeps it to one row; PG has no UPDATE..LIMIT, so PG tables without keys stay read-only in the UI
  const limit = !keyIsUnique && d === 'mysql' ? ' LIMIT 1' : ''
  return `UPDATE ${qt(d, schema, table)} SET ${set} WHERE ${keyWhere(d, key, types)}${limit};`
}

export function insertSql(d: Dialect, schema: string, table: string, values: Record<string, CellValue>, types: Record<string, string> = {}): string {
  const cols = Object.keys(values)
  if (!cols.length) return d === 'mysql' ? `INSERT INTO ${qt(d, schema, table)} () VALUES ();` : `INSERT INTO ${qt(d, schema, table)} DEFAULT VALUES;`
  return `INSERT INTO ${qt(d, schema, table)} (${cols.map((c) => qi(d, c)).join(', ')}) VALUES (${cols.map((c) => lit(d, values[c], types[c])).join(', ')});`
}

export function deleteSql(d: Dialect, schema: string, table: string, key: Record<string, CellValue>, types: Record<string, string> = {}, keyIsUnique = true): string {
  const limit = !keyIsUnique && d === 'mysql' ? ' LIMIT 1' : ''
  return `DELETE FROM ${qt(d, schema, table)} WHERE ${keyWhere(d, key, types)}${limit};`
}

// ---------- structure (DDL) ----------

export interface ColumnDraft { name: string; type: string; nullable: boolean; default: string | null; comment?: string | null }

const defaultClause = (v: string | null): string => (v === null || v === '' ? '' : ` DEFAULT ${v}`)

export function columnDef(d: Dialect, c: ColumnDraft): string {
  return `${qi(d, c.name)} ${c.type}${c.nullable ? '' : ' NOT NULL'}${defaultClause(c.default)}${d === 'mysql' && c.comment ? ` COMMENT ${lit(d, c.comment)}` : ''}`
}

export function createTableSql(d: Dialect, schema: string, table: string, cols: ColumnDraft[], pk: string[]): string {
  const lines = cols.map((c) => '  ' + columnDef(d, c))
  if (pk.length) lines.push(`  PRIMARY KEY (${pk.map((c) => qi(d, c)).join(', ')})`)
  return `CREATE TABLE ${qt(d, schema, table)} (\n${lines.join(',\n')}\n);`
}

export const addColumnSql = (d: Dialect, schema: string, table: string, c: ColumnDraft): string[] => {
  const out = [`ALTER TABLE ${qt(d, schema, table)} ADD COLUMN ${columnDef(d, c)};`]
  if (d === 'postgres' && c.comment) out.push(`COMMENT ON COLUMN ${qt(d, schema, table)}.${qi(d, c.name)} IS ${lit(d, c.comment)};`)
  return out
}

export const dropColumnSql = (d: Dialect, schema: string, table: string, name: string): string =>
  `ALTER TABLE ${qt(d, schema, table)} DROP COLUMN ${qi(d, name)};`

/** Statements to turn column `from` into `to`. SQLite only supports rename. */
export function alterColumnSql(d: Dialect, schema: string, table: string, from: ColumnDraft, to: ColumnDraft): string[] {
  const t = qt(d, schema, table)
  const out: string[] = []
  if (d === 'mysql') {
    out.push(`ALTER TABLE ${t} CHANGE COLUMN ${qi(d, from.name)} ${columnDef(d, to)};`)
    return out
  }
  if (from.name !== to.name) out.push(`ALTER TABLE ${t} RENAME COLUMN ${qi(d, from.name)} TO ${qi(d, to.name)};`)
  if (d === 'sqlite') {
    if (from.type !== to.type || from.nullable !== to.nullable || from.default !== to.default)
      throw new Error('SQLite cannot change a column type, nullability or default in place.')
    return out
  }
  const c = qi(d, to.name)
  if (from.type !== to.type) out.push(`ALTER TABLE ${t} ALTER COLUMN ${c} TYPE ${to.type} USING ${c}::${to.type};`)
  if (from.nullable !== to.nullable) out.push(`ALTER TABLE ${t} ALTER COLUMN ${c} ${to.nullable ? 'DROP' : 'SET'} NOT NULL;`)
  if (from.default !== to.default)
    out.push(to.default === null || to.default === '' ? `ALTER TABLE ${t} ALTER COLUMN ${c} DROP DEFAULT;` : `ALTER TABLE ${t} ALTER COLUMN ${c} SET DEFAULT ${to.default};`)
  if ((from.comment ?? '') !== (to.comment ?? '')) out.push(`COMMENT ON COLUMN ${t}.${c} IS ${to.comment ? lit(d, to.comment) : 'NULL'};`)
  return out
}

export function setPrimaryKeySql(d: Dialect, schema: string, table: string, cols: string[], hadPk: boolean, pkName?: string): string[] {
  const t = qt(d, schema, table)
  if (d === 'sqlite') throw new Error('SQLite cannot change the primary key of an existing table.')
  const out: string[] = []
  if (hadPk) out.push(d === 'mysql' ? `ALTER TABLE ${t} DROP PRIMARY KEY;` : `ALTER TABLE ${t} DROP CONSTRAINT ${qi(d, pkName || `${table}_pkey`)};`)
  if (cols.length) out.push(`ALTER TABLE ${t} ADD PRIMARY KEY (${cols.map((c) => qi(d, c)).join(', ')});`)
  return out
}

export function addForeignKeySql(d: Dialect, schema: string, table: string, fk: ForeignKey): string {
  if (d === 'sqlite') throw new Error('SQLite cannot add a foreign key to an existing table.')
  const name = fk.name ? `CONSTRAINT ${qi(d, fk.name)} ` : ''
  return `ALTER TABLE ${qt(d, schema, table)} ADD ${name}FOREIGN KEY (${fk.columns.map((c) => qi(d, c)).join(', ')}) REFERENCES ${qt(d, fk.refSchema || schema, fk.refTable)} (${fk.refColumns.map((c) => qi(d, c)).join(', ')}) ON UPDATE ${fk.onUpdate} ON DELETE ${fk.onDelete};`
}

export function dropForeignKeySql(d: Dialect, schema: string, table: string, name: string): string {
  if (d === 'sqlite') throw new Error('SQLite cannot drop a foreign key from an existing table.')
  return `ALTER TABLE ${qt(d, schema, table)} DROP ${d === 'mysql' ? 'FOREIGN KEY' : 'CONSTRAINT'} ${qi(d, name)};`
}

export function createIndexSql(d: Dialect, schema: string, table: string, ix: Pick<Index, 'name' | 'columns' | 'unique'> & { condition?: string | null }): string {
  const where = ix.condition && d !== 'mysql' ? ` WHERE ${ix.condition}` : ''
  return `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${qi(d, ix.name)} ON ${qt(d, schema, table)} (${ix.columns.map((c) => qi(d, c)).join(', ')})${where};`
}

export function dropIndexSql(d: Dialect, schema: string, table: string, name: string): string {
  if (d === 'mysql') return `DROP INDEX ${qi(d, name)} ON ${qt(d, schema, table)};`
  return `DROP INDEX ${d === 'postgres' ? qt(d, schema, name) : qi(d, name)};`
}

export const renameTableSql = (d: Dialect, schema: string, from: string, to: string): string =>
  d === 'mysql' ? `RENAME TABLE ${qt(d, schema, from)} TO ${qt(d, schema, to)};` : `ALTER TABLE ${qt(d, schema, from)} RENAME TO ${qi(d, to)};`

export const dropObjectSql = (d: Dialect, kind: string, schema: string, name: string, cascade = false): string => {
  const k = kind === 'matview' ? 'MATERIALIZED VIEW' : kind.toUpperCase()
  return `DROP ${k} ${qt(d, schema, name)}${cascade && d === 'postgres' ? ' CASCADE' : ''};`
}

export function truncateSql(d: Dialect, schema: string, table: string, opts: { cascade?: boolean; restartIdentity?: boolean } = {}): string {
  if (d === 'sqlite') return `DELETE FROM ${qt(d, schema, table)};`
  if (d === 'mysql') return `TRUNCATE TABLE ${qt(d, schema, table)};`
  return `TRUNCATE TABLE ${qt(d, schema, table)}${opts.restartIdentity ? ' RESTART IDENTITY' : ''}${opts.cascade ? ' CASCADE' : ''};`
}

export const cloneTableSql = (d: Dialect, schema: string, from: string, to: string, withData: boolean): string[] => {
  if (d === 'mysql') return [`CREATE TABLE ${qt(d, schema, to)} LIKE ${qt(d, schema, from)};`, ...(withData ? [`INSERT INTO ${qt(d, schema, to)} SELECT * FROM ${qt(d, schema, from)};`] : [])]
  if (d === 'postgres') return [`CREATE TABLE ${qt(d, schema, to)} (LIKE ${qt(d, schema, from)} INCLUDING ALL);`, ...(withData ? [`INSERT INTO ${qt(d, schema, to)} SELECT * FROM ${qt(d, schema, from)};`] : [])]
  return [`CREATE TABLE ${qi(d, to)} AS SELECT * FROM ${qi(d, from)}${withData ? '' : ' WHERE 0'};`]
}

export const FILTER_OPS: Record<Dialect, string[]> = {
  sqlite: ['=', '<>', '<', '>', '<=', '>=', 'IN', 'NOT IN', 'IS NULL', 'IS NOT NULL', 'BETWEEN', 'NOT BETWEEN', 'LIKE', 'Contains', 'Not contains', 'Has prefix', 'Has suffix'],
  mysql: ['=', '<>', '<', '>', '<=', '>=', 'IN', 'NOT IN', 'IS NULL', 'IS NOT NULL', 'BETWEEN', 'NOT BETWEEN', 'LIKE', 'Contains', 'Not contains', 'Has prefix', 'Has suffix'],
  postgres: ['=', '<>', '<', '>', '<=', '>=', 'IN', 'NOT IN', 'IS NULL', 'IS NOT NULL', 'BETWEEN', 'NOT BETWEEN', 'LIKE', 'ILIKE', 'Contains', 'Not contains', 'Has prefix', 'Has suffix', 'Contains (ci)', 'Not contains (ci)', 'Has prefix (ci)', 'Has suffix (ci)']
}

export const TYPE_LIST: Record<Dialect, string[]> = {
  postgres: ['integer', 'bigint', 'smallint', 'serial', 'bigserial', 'numeric', 'real', 'double precision', 'boolean', 'text', 'varchar(255)', 'char(1)', 'uuid', 'date', 'time', 'timestamp', 'timestamptz', 'interval', 'json', 'jsonb', 'bytea', 'inet', 'text[]', 'integer[]'],
  mysql: ['int', 'bigint', 'smallint', 'tinyint', 'decimal(10,2)', 'float', 'double', 'bit(1)', 'varchar(255)', 'char(1)', 'text', 'mediumtext', 'longtext', 'date', 'time', 'datetime', 'timestamp', 'year', 'json', 'blob', 'longblob', "enum('a','b')"],
  sqlite: ['INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC', 'BOOLEAN', 'DATE', 'DATETIME']
}

export const DEFAULT_PRESETS: Record<Dialect, string[]> = {
  postgres: ['NULL', "''", 'CURRENT_TIMESTAMP', 'now()', 'gen_random_uuid()', 'true', 'false', '0'],
  mysql: ['NULL', "''", 'CURRENT_TIMESTAMP', '(UUID())', '0', '1'],
  sqlite: ['NULL', "''", 'CURRENT_TIMESTAMP', '0', '1']
}

export const FK_ACTIONS = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']
