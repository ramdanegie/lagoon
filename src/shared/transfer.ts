// Pure Data Transfer helpers: column type mapping between dialects, value conversion, FK load order,
// CREATE TABLE for the target and paged reads. Shared by main (jobs) and the renderer. Tested in test/transfer.test.ts.
import type { Column, Dialect } from './types'
import { qi, qt, lit, createTableSql, type CellValue } from './sqlgen'

export type Family = 'smallint' | 'int' | 'bigint' | 'decimal' | 'float' | 'double' | 'bool' | 'char' | 'varchar' | 'text' | 'uuid' | 'date' | 'time' | 'timestamp' | 'timestamptz' | 'json' | 'binary'
/** `text`: a string type whose keys sort by a binary collation (so the order is the same on every engine). */
export interface TypeInfo { fam: Family; len?: number; p?: number; s?: number; text?: boolean }

const NUMERIC_FAMS: Family[] = ['smallint', 'int', 'bigint', 'decimal', 'float', 'double']
export const isNumericFam = (f: Family): boolean => NUMERIC_FAMS.includes(f)
const STRING_FAMS: Family[] = ['char', 'varchar', 'text', 'uuid']

/** Conservative type family of a column type as the driver reports it (format_type / COLUMN_TYPE / declared type). */
export function classify(type: string, d: Dialect): TypeInfo {
  const t = (type ?? '').trim().toLowerCase()
  const args = (/\(([\d\s,]+)\)/.exec(t)?.[1] ?? '').split(',').map((x) => parseInt(x)).filter((n) => !isNaN(n))
  const unsigned = /\bunsigned\b/.test(t)
  const base = t.replace(/\([^)]*\)/g, '').replace(/\b(unsigned|signed|zerofill)\b/g, '').replace(/\s+/g, ' ').trim()
  const str = (fam: Family, len?: number): TypeInfo => ({ fam, len, text: true })
  if (t.endsWith('[]')) return { fam: 'text' } // PG arrays travel as their text form
  if (/^(bool|boolean)$/.test(base) || (d === 'mysql' && /^tinyint\(1\)/.test(t)) || (base === 'bit' && (args[0] ?? 1) === 1)) return { fam: 'bool' }
  if (/^(bit|bit varying|varbit)$/.test(base)) return d === 'mysql' ? { fam: 'binary' } : { fam: 'text' }
  if (/^(tinyint|int1|int2|smallint|smallserial|year)$/.test(base)) return { fam: base === 'smallint' && unsigned ? 'int' : 'smallint' }
  if (/^(mediumint|int|integer|int3|int4|serial)$/.test(base)) return { fam: d === 'sqlite' || unsigned ? 'bigint' : 'int' } // SQLite INTEGER is 64-bit
  if (/^(bigint|int8|bigserial)$/.test(base)) return unsigned ? { fam: 'decimal', p: 20, s: 0 } : { fam: 'bigint' }
  if (/^(numeric|decimal|dec|fixed|number)$/.test(base)) return { fam: 'decimal', p: args[0], s: args[0] ? (args[1] ?? 0) : undefined }
  if (/^(real|float4)$/.test(base)) return { fam: d === 'sqlite' ? 'double' : 'float' }
  if (base === 'float') return { fam: d === 'mysql' && !(args[0] > 24) ? 'float' : 'double' }
  if (/^(double|double precision|float8)$/.test(base)) return { fam: 'double' }
  if (base === 'uuid') return { fam: 'uuid' }
  if (/^jsonb?$/.test(base)) return { fam: 'json' }
  if (/^(bytea|blob|tinyblob|mediumblob|longblob|binary|varbinary)$/.test(base)) return { fam: 'binary' }
  if (base === 'date') return { fam: 'date' }
  if (/^(time|time without time zone|time with time zone|timetz)$/.test(base)) return { fam: 'time' }
  if (/^(timestamptz|timestamp with time zone)$/.test(base)) return { fam: 'timestamptz' }
  if (/^(timestamp|timestamp without time zone|datetime|smalldatetime)$/.test(base)) return { fam: 'timestamp' }
  if (/^(character varying|varchar|nvarchar|varchar2|nvarchar2)$/.test(base)) return args[0] ? str('varchar', args[0]) : str('text')
  if (/^(character|char|nchar|bpchar)$/.test(base)) return str('char', args[0] || 1)
  if (/^(text|tinytext|mediumtext|longtext|clob|citext|string)$/.test(base)) return str('text')
  if (d === 'mysql' && /^(enum|set)$/.test(base)) return str('text')
  if (d === 'sqlite' && base) {
    // SQLite type affinity rules for any other declared type
    if (base.includes('int')) return { fam: 'bigint' }
    if (/char|clob|text/.test(base)) return str('text')
    if (base.includes('blob')) return { fam: 'binary' }
    if (/real|floa|doub/.test(base)) return { fam: 'double' }
    return { fam: 'decimal' }
  }
  return { fam: 'text' } // enums, inet, interval, xml, money, untyped SQLite…: copied as text
}

/** A column type for `to` that holds the family. `key`: the column is part of the primary key (MySQL cannot index TEXT/BLOB). */
export function renderType(i: TypeInfo, to: Dialect, key = false): string {
  const len = i.len ?? 255
  const p = i.p
  const s = i.s ?? 0
  if (to === 'postgres') {
    const m: Record<Family, string> = { smallint: 'smallint', int: 'integer', bigint: 'bigint', decimal: p ? `numeric(${p},${s})` : 'numeric', float: 'real', double: 'double precision', bool: 'boolean', char: `char(${len})`, varchar: `varchar(${len})`, text: 'text', uuid: 'uuid', date: 'date', time: 'time', timestamp: 'timestamp', timestamptz: 'timestamptz', json: 'jsonb', binary: 'bytea' }
    return m[i.fam]
  }
  if (to === 'mysql') {
    const v = key ? Math.min(len, 768) : len // 768 × 4 bytes is InnoDB's key limit
    const m: Record<Family, string> = {
      smallint: 'smallint', int: 'int', bigint: 'bigint', decimal: p ? `decimal(${Math.min(p, 65)},${Math.min(s, 30, p)})` : 'decimal(65,30)', float: 'float', double: 'double', bool: 'tinyint(1)',
      char: len <= 255 ? `char(${len})` : key ? 'varchar(768)' : 'longtext', varchar: v <= 16383 ? `varchar(${v})` : 'longtext', text: key ? 'varchar(255)' : 'longtext', uuid: 'char(36)',
      date: 'date', time: 'time(6)', timestamp: 'datetime(6)', timestamptz: 'datetime(6)', json: 'json', binary: key ? 'varbinary(255)' : 'longblob'
    }
    // keys keep the source's case- and accent-sensitive uniqueness (MySQL's default collations fold both)
    return key && i.text ? `${m[i.fam]} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin` : m[i.fam]
  }
  const m: Record<Family, string> = { smallint: 'INTEGER', int: 'INTEGER', bigint: 'INTEGER', decimal: 'NUMERIC', float: 'REAL', double: 'REAL', bool: 'BOOLEAN', char: 'TEXT', varchar: 'TEXT', text: 'TEXT', uuid: 'TEXT', date: 'DATE', time: 'TEXT', timestamp: 'DATETIME', timestamptz: 'DATETIME', json: 'TEXT', binary: 'BLOB' }
  return m[i.fam]
}

/** Target column type. The same dialect keeps the type verbatim. */
export const mapType = (type: string, from: Dialect, to: Dialect, key = false): string =>
  from === to && type ? type : renderType(classify(type, from), to, key)

/** Families that hold each other's values when comparing rows across engines. */
export function compatible(a: TypeInfo, b: TypeInfo): boolean {
  if (a.fam === b.fam) return true
  if (isNumericFam(a.fam) && isNumericFam(b.fam)) return true
  if (STRING_FAMS.includes(a.fam) && STRING_FAMS.includes(b.fam)) return true
  const ts: Family[] = ['timestamp', 'timestamptz']
  if (ts.includes(a.fam) && ts.includes(b.fam)) return true
  const bi: Family[] = ['bool', 'smallint']
  return bi.includes(a.fam) && bi.includes(b.fam)
}

export const isAutoInc = (c: Pick<Column, 'default' | 'extra'>, from: Dialect): boolean =>
  from === 'postgres' ? c.extra === 'identity' || /^nextval\(/i.test(c.default ?? '') : from === 'mysql' && /auto_increment/i.test(c.extra ?? '')

/** Integer auto-increment / identity / serial column: becomes an identity (PG) or AUTO_INCREMENT key (MySQL) on the target. */
export const isIdentity = (c: Pick<Column, 'default' | 'extra' | 'type'>, from: Dialect): boolean =>
  isAutoInc(c, from) && ['smallint', 'int', 'bigint'].includes(classify(c.type, from).fam)

const TS_NOW = /^(current_timestamp|now|localtimestamp|getdate)\s*(\(\s*\d*\s*\))?$/i

/** A column default that means the same on the target, or null to leave it out. */
export function portDefault(c: Pick<Column, 'default' | 'extra' | 'type'>, from: Dialect, to: Dialect, targetType: string): string | null {
  if (c.default === null || c.default === undefined) return null
  let v = String(c.default).trim()
  if (/^nextval\(/i.test(v)) return null
  if (from === to && from !== 'mysql') return v // MySQL reports string defaults unquoted, so those go through the rules below
  if (from === 'postgres') v = v.replace(/^\((.*)\)$/, '$1').replace(/::[\w\s".[\]]+$/, '').replace(/^\((.*)\)$/, '$1')
  const fam = classify(c.type, from).fam
  if (TS_NOW.test(v)) {
    if (fam !== 'timestamp' && fam !== 'timestamptz') return null
    return to === 'mysql' && /\(6\)/.test(targetType) ? 'CURRENT_TIMESTAMP(6)' : 'CURRENT_TIMESTAMP'
  }
  if (fam === 'bool') {
    const on = /^(true|'?1'?|b'1'|'t')$/i.test(v)
    const off = /^(false|'?0'?|b'0'|'f')$/i.test(v)
    if (!on && !off) return null
    return to === 'postgres' ? (on ? 'true' : 'false') : on ? '1' : '0'
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) return isNumericFam(fam) ? v : lit(to, v)
  if (/^'(?:[^']|'')*'$/.test(v)) return v
  if (from === 'mysql' && STRING_FAMS.includes(fam) && !/DEFAULT_GENERATED/i.test(c.extra ?? '')) return lit(to, v)
  return null
}

/** CREATE TABLE on the target: mapped column types, NOT NULL, portable defaults, identity / auto-increment and the primary key. */
export function createSql(from: Dialect, to: Dialect, schema: string, table: string, cols: Column[], opts: { ifNotExists?: boolean } = {}): string {
  const pk = cols.filter((c) => c.pk).map((c) => c.name)
  const drafts = cols.map((c) => {
    let type = mapType(c.type, from, to, c.pk)
    const auto = isIdentity(c, from)
    if (auto && to === 'postgres') type += ' GENERATED BY DEFAULT AS IDENTITY'
    if (auto && to === 'mysql' && c.pk) type += ' AUTO_INCREMENT'
    return { name: c.name, type, nullable: c.nullable && !c.pk, default: auto ? null : portDefault(c, from, to, type) }
  })
  const sql = createTableSql(to, schema, table, drafts, pk)
  return opts.ifNotExists ? sql.replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS ') : sql
}

/** After loading explicit ids into a new PG identity column, move its sequence past the largest id. */
export const resetSequenceSql = (schema: string, table: string, col: string): string =>
  `SELECT setval(pg_get_serial_sequence(${lit('postgres', qt('postgres', schema, table))}, ${lit('postgres', col)}), COALESCE((SELECT MAX(${qi('postgres', col)}) FROM ${qt('postgres', schema, table)}), 0) + 1, false)`

const truthy = (v: unknown): boolean => v === true || v === 1 || (typeof v === 'string' && /^(t|true|1|y|yes|on)$/i.test(v.trim()))

/** '2024-01-02 10:00:00.5+02' → '2024-01-02 08:00:00.5' (UTC, no offset). Values without an offset come back unchanged. */
export function utcPlain(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?\s*(Z|[+-]\d{2}(?::?\d{2})?)$/i.exec(v.trim())
  if (!m) return v
  const [, y, mo, d, h, mi, s, frac = '', off] = m
  let mins = 0
  if (off.toUpperCase() !== 'Z') {
    const o = off.replace(':', '')
    mins = (o[0] === '-' ? -1 : 1) * (Number(o.slice(1, 3)) * 60 + Number(o.slice(3, 5) || 0))
  }
  const t = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - mins * 60000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}${frac}`
}

/** A value read from a source column, shaped for an INSERT/UPDATE literal on a target column. */
export function convertValue(v: unknown, dst: TypeInfo, to: Dialect): CellValue {
  if (v === null || v === undefined) return null
  if (dst.fam === 'bool') return truthy(v)
  if (typeof v === 'boolean') return isNumericFam(dst.fam) ? (v ? 1 : 0) : String(v)
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'object') return JSON.stringify(v)
  if (typeof v === 'number') return v
  const s = String(v)
  if (dst.fam === 'binary' && /^\\x[0-9a-f]*$/i.test(s)) return to === 'postgres' ? s : { raw: `X'${s.slice(2)}'` }
  if (dst.fam === 'timestamp' || dst.fam === 'timestamptz' || dst.fam === 'date') {
    if (to !== 'mysql' && /^0000-00-00/.test(s)) return null // MySQL zero dates have no equivalent
    if (to !== 'postgres') return utcPlain(s) // only PG keeps an offset; elsewhere store UTC
  }
  return s
}

/** Tables ordered so referenced (parent) tables come first. Cycles keep their input order. */
export function fkOrder(names: string[], parents: Record<string, string[]>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const visit = (n: string): void => {
    if (seen.has(n)) return
    seen.add(n)
    for (const p of parents[n] ?? []) if (p !== n && names.includes(p)) visit(p)
    out.push(n)
  }
  names.forEach(visit)
  return out
}

// ---------- paged reads ----------
export interface ReadSpec {
  schema: string
  table: string
  cols: string[]
  keys: { name: string; text?: boolean; type?: string }[] // ordering columns (binary collation when `text`)
  where?: string
  notNullKeys?: boolean
}

const keyExpr = (d: Dialect, k: ReadSpec['keys'][number]): string =>
  !k.text ? qi(d, k.name) : d === 'postgres' ? `${qi(d, k.name)} COLLATE "C"` : d === 'mysql' ? `CAST(${qi(d, k.name)} AS BINARY)` : `${qi(d, k.name)} COLLATE BINARY`

function conds(d: Dialect, q: ReadSpec): string[] {
  const out: string[] = []
  if (q.where?.trim()) out.push(`(${q.where.trim()})`)
  if (q.notNullKeys) for (const k of q.keys) out.push(`${qi(d, k.name)} IS NOT NULL`)
  return out
}

export const orderSql = (d: Dialect, keys: ReadSpec['keys']): string => (keys.length ? ` ORDER BY ${keys.map((k) => keyExpr(d, k)).join(', ')}` : '')

/** SELECT for a PG cursor (`ordered`: in key order). */
export function cursorSelect(d: Dialect, q: ReadSpec, ordered: boolean): string {
  const c = conds(d, q)
  return `SELECT ${q.cols.map((x) => qi(d, x)).join(', ')} FROM ${qt(d, q.schema, q.table)}${c.length ? ` WHERE ${c.join(' AND ')}` : ''}${ordered ? orderSql(d, q.keys) : ''}`
}

/** One page: keyset after the last row's key values when the keys are selected, else LIMIT/OFFSET. */
export function pageSql(d: Dialect, q: ReadSpec, after: unknown[] | null, limit: number, offset = 0): string {
  const c = conds(d, q)
  const keyset = q.keys.length > 0 && q.keys.every((k) => q.cols.includes(k.name))
  if (keyset && after) {
    const l = q.keys.map((k, i) => lit(d, after[i] as CellValue, k.type))
    c.push(q.keys.length === 1 ? `${keyExpr(d, q.keys[0])} > ${l[0]}` : `(${q.keys.map((k) => keyExpr(d, k)).join(', ')}) > (${l.join(', ')})`)
  }
  return `SELECT ${q.cols.map((x) => qi(d, x)).join(', ')} FROM ${qt(d, q.schema, q.table)}${c.length ? ` WHERE ${c.join(' AND ')}` : ''}${orderSql(d, q.keys)} LIMIT ${limit}${keyset || !offset ? '' : ` OFFSET ${offset}`}`
}
