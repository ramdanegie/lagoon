// Pure import/export/backup helpers shared by main (jobs) and the renderer (wizards). Tested in test/importexport.test.ts.
import type { Dialect } from './types'
import { qi, qt, lit, keyWhere, updateSql, type CellValue } from './sqlgen'

export type Matching = 'nameOrder' | 'name' | 'order'
/** Import mode. stop = append (fail on a duplicate key), update = upsert, replace = delete + re-insert (MySQL/SQLite),
 *  skip = insert only new keys, updateOnly = update matching rows, delete = delete matching rows, truncate = empty the table first. */
export type Conflict = 'stop' | 'update' | 'replace' | 'skip' | 'updateOnly' | 'delete' | 'truncate'

/** Modes that match rows by key columns (MySQL upsert / skip use the table's own unique keys instead). */
export const needsKeys = (mode: Conflict, d: Dialect): boolean => mode === 'updateOnly' || mode === 'delete' || (mode === 'update' && d !== 'mysql')

/** Parse delimited text (CSV/TSV). `quote` '' turns quoting off. Blank lines are dropped. */
export function parseDelimited(text: string, delim = ',', quote = '"'): string[][] {
  if (!delim) delim = ',' // an empty delimiter would never advance
  const rows: string[][] = []
  let row: string[] = []
  let i = 0
  const n = text.length
  while (i < n) {
    let cell = ''
    if (quote && text.startsWith(quote, i)) {
      let j = i + quote.length
      for (;;) {
        const k = text.indexOf(quote, j)
        if (k < 0) { cell += text.slice(j); i = n; break }
        cell += text.slice(j, k)
        if (text.startsWith(quote, k + quote.length)) { cell += quote; j = k + 2 * quote.length } else { i = k + quote.length; break }
      }
    }
    // unquoted cell, or stray text after a closing quote, runs to the next delimiter / line end
    let k = i
    while (k < n && text[k] !== '\n' && text[k] !== '\r' && !text.startsWith(delim, k)) k++
    cell += text.slice(i, k)
    i = k
    row.push(cell)
    if (i < n && text.startsWith(delim, i)) {
      i += delim.length
      if (i >= n) row.push('')
      continue
    }
    if (text[i] === '\r') i++
    if (text[i] === '\n') i++
    if (!(row.length === 1 && row[0] === '')) rows.push(row)
    row = []
  }
  if (row.length) rows.push(row)
  return rows
}

/** Array of objects, a single object, or newline-delimited JSON. */
export function parseJsonRecords(text: string): Record<string, unknown>[] {
  const t = text.trim()
  let recs: unknown[]
  try {
    const v = JSON.parse(t)
    recs = Array.isArray(v) ? v : [v]
  } catch (e) {
    if (t.startsWith('[')) throw new Error(`Not valid JSON: ${(e as Error).message}`, { cause: e })
    recs = t.split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
      try { return JSON.parse(l) } catch { throw new Error(`Line ${i + 1} is not valid JSON.`) }
    })
  }
  recs.forEach((r, i) => { if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error(`Record ${i + 1} is not a JSON object.`) })
  return recs as Record<string, unknown>[]
}

/** Union of top-level keys in first-seen order. */
export const jsonColumns = (recs: Record<string, unknown>[]): string[] => [...new Set(recs.flatMap((r) => Object.keys(r)))]

/** Usable, unique column names: blanks become column_N, repeats get _2, _3… */
export function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>()
  return names.map((raw, i) => {
    const base = raw.trim() || `column_${i + 1}`
    let name = base
    for (let k = 2; seen.has(name.toLowerCase()); k++) name = `${base}_${k}`
    seen.add(name.toLowerCase())
    return name
  })
}

const TYPES: Record<Dialect, Record<'int' | 'big' | 'num' | 'bool' | 'date' | 'ts' | 'text', string>> = {
  postgres: { int: 'integer', big: 'bigint', num: 'numeric', bool: 'boolean', date: 'date', ts: 'timestamp', text: 'text' },
  mysql: { int: 'int', big: 'bigint', num: 'double', bool: 'tinyint(1)', date: 'date', ts: 'datetime', text: 'text' },
  sqlite: { int: 'INTEGER', big: 'INTEGER', num: 'REAL', bool: 'BOOLEAN', date: 'DATE', ts: 'DATETIME', text: 'TEXT' }
}
export const textType = (d: Dialect): string => TYPES[d].text

/** Column type guessed from sample values ('' counts as missing). */
export function detectType(values: string[], d: Dialect): string {
  const v = values.filter((x) => x !== '')
  const t = TYPES[d]
  if (!v.length) return t.text
  const all = (re: RegExp): boolean => v.every((x) => re.test(x))
  if (all(/^-?\d{1,18}$/)) return v.every((x) => Math.abs(Number(x)) <= 2147483647) ? t.int : t.big
  if (all(/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/)) return t.num
  if (all(/^(true|false)$/i)) return t.bool
  if (all(/^\d{4}-\d{2}-\d{2}$/)) return t.date
  if (all(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/)) return t.ts
  return t.text
}

/** Destination column for each source column (null = skip). */
export function matchColumns(src: string[], dest: string[], m: Matching, ci = false): (string | null)[] {
  const norm = (s: string): string => (ci ? s.toLowerCase() : s)
  const byName = src.map((s) => dest.find((d) => norm(d) === norm(s)) ?? null)
  return src.map((_s, i) => {
    if (m === 'order') return dest[i] ?? null
    if (byName[i] || m === 'name') return byName[i]
    const pos = dest[i]
    return pos && !byName.includes(pos) ? pos : null
  })
}

/** File-system safe name from a pattern with {connection} {database} {schema} {table} {date} {time}. */
export function expandPattern(pattern: string, tokens: Record<string, string | undefined>, now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const all: Record<string, string | undefined> = {
    date: `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`,
    time: `${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`,
    ...tokens
  }
  // eslint-disable-next-line no-control-regex
  const out = pattern.replace(/\{(\w+)\}/g, (m, k: string) => all[k] ?? (k in all ? '' : m)).replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').trim()
  return out.replace(/^\.+/, '') || 'export'
}

/** Split an options string into argv, honouring "double" and 'single' quotes. */
export function splitArgs(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = ''
  let has = false
  for (const ch of s) {
    if (q) { if (ch === q) q = ''; else cur += ch }
    else if (ch === '"' || ch === "'") { q = ch; has = true }
    else if (/\s/.test(ch)) { if (has || cur) out.push(cur); cur = ''; has = false }
    else cur += ch
  }
  if (has || cur) out.push(cur)
  return out
}

export interface ToolTarget { host: string; port: number; user?: string; database: string }

/** argv for the CLI tools. Passwords never go here: they travel in PGPASSWORD / MYSQL_PWD. */
export function toolArgs(tool: 'pg_dump' | 'pg_restore' | 'psql' | 'mysqldump' | 'mysql', t: ToolTarget, options: string): string[] {
  const opts = splitArgs(options)
  if (tool === 'mysqldump' || tool === 'mysql') return ['-h', t.host, '-P', String(t.port), '--protocol=TCP', ...(t.user ? ['-u', t.user] : []), ...opts, t.database]
  const base = ['-h', t.host, '-p', String(t.port), ...(t.user ? ['-U', t.user] : []), '-w', '-d', t.database]
  if (tool === 'psql') return [...base, '-v', 'ON_ERROR_STOP=1', ...opts.filter((o) => o === '--single-transaction' || o === '-1')]
  return [...base, ...opts]
}

/** pg_dump options that produce an archive (custom/tar/directory) rather than plain SQL. */
export const isArchiveFormat = (options: string): boolean => /(--format[= ]?(c|custom|t|tar|d|directory)\b|-F\s*[ctd]\b)/.test(options)

export interface CsvOut { delimiter: string; quote: string; lineBreak: string; decimal: string; nullAsEmpty: boolean; breakToSpace: boolean; header: boolean }
export const CSV_DEFAULTS: CsvOut = { delimiter: ',', quote: '"', lineBreak: '\n', decimal: '.', nullAsEmpty: false, breakToSpace: false, header: true }

/** One CSV line (no line break). `numeric[i]` marks columns whose decimal point is swapped. */
export function csvRow(vals: unknown[], o: CsvOut, numeric: boolean[] = []): string {
  return vals.map((v, i) => {
    if (v === null || v === undefined) return o.nullAsEmpty ? '' : 'NULL'
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    if (o.decimal !== '.' && (typeof v === 'number' || numeric[i])) s = s.replace('.', o.decimal)
    if (o.breakToSpace) s = s.replace(/\r?\n|\r/g, ' ')
    const need = s.includes(o.delimiter) || /[\r\n]/.test(s) || (!!o.quote && s.includes(o.quote)) || s !== s.trim()
    return need && o.quote ? o.quote + s.split(o.quote).join(o.quote + o.quote) + o.quote : s
  }).join(o.delimiter)
}

/** Numbers stay numbers in JSON/Excel even when the driver sent text (Postgres does). */
export function typedValue(v: unknown, numeric: boolean): unknown {
  if (numeric && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && String(Number(v)) === v) return Number(v)
  return v
}

/** A value from a CSV/JSON file, shaped for a destination column type. */
export function importValue(v: unknown, type: string): CellValue {
  if (v === null || v === undefined) return null
  if (typeof v === 'object') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return v
  const s = String(v)
  if (s === '' && type && !/char|text|clob|string|json|enum|set\(/i.test(type)) return null
  if (/^(bool|boolean|tinyint\(1\)|bit(\(1\))?)$/i.test(type.trim()) && /^(true|false)$/i.test(s)) return /^true$/i.test(s)
  return s
}

/** A value read from a table, shaped for an INSERT in an exported .sql file. */
export function exportValue(d: Dialect, v: unknown, type: string): CellValue {
  if (typeof v === 'string' && d !== 'postgres' && /blob|binary/i.test(type) && /^\\x[0-9a-f]*$/i.test(v)) return { raw: `X'${v.slice(2)}'` }
  return v as CellValue
}

/** Multi-row INSERT with an optional key-conflict clause. `pk` = key columns for Postgres/SQLite upserts. */
export function insertManySql(d: Dialect, schema: string, table: string, cols: string[], rows: CellValue[][], types: string[] = [], conflict: Conflict = 'stop', pk: string[] = []): string {
  const verb = conflict === 'replace' ? (d === 'mysql' ? 'REPLACE' : d === 'sqlite' ? 'INSERT OR REPLACE' : 'INSERT')
    : conflict === 'skip' ? (d === 'mysql' ? 'INSERT IGNORE' : d === 'sqlite' ? 'INSERT OR IGNORE' : 'INSERT') : 'INSERT'
  const body = rows.map((r) => `(${r.map((v, i) => lit(d, v, types[i])).join(', ')})`).join(',\n')
  let tail = ''
  if (conflict === 'update' && d !== 'mysql') {
    if (!pk.length) throw new Error('Updating existing rows needs key columns: choose them, or give the destination table a primary key.')
    const upd = cols.filter((c) => !pk.includes(c))
    tail = ` ON CONFLICT (${pk.map((c) => qi(d, c)).join(', ')}) DO ${upd.length ? `UPDATE SET ${upd.map((c) => `${qi(d, c)} = EXCLUDED.${qi(d, c)}`).join(', ')}` : 'NOTHING'}`
  } else if (conflict === 'update' && d === 'mysql') {
    tail = ` ON DUPLICATE KEY UPDATE ${cols.map((c) => `${qi(d, c)} = VALUES(${qi(d, c)})`).join(', ')}`
  } else if (conflict === 'skip' && d === 'postgres') tail = ' ON CONFLICT DO NOTHING'
  return `${verb} INTO ${qt(d, schema, table)} (${cols.map((c) => qi(d, c)).join(', ')}) VALUES\n${body}${tail}`
}

/** Statements that apply one batch of file rows in the given mode. Update and delete match rows by `keys`. */
export function importBatchSql(d: Dialect, schema: string, table: string, cols: string[], rows: CellValue[][], types: string[], mode: Conflict, keys: string[]): string[] {
  if (mode !== 'updateOnly' && mode !== 'delete') return [insertManySql(d, schema, table, cols, rows, types, mode === 'truncate' ? 'stop' : mode, keys)]
  if (!keys.length) throw new Error('This mode needs key columns: choose them, or give the destination table a primary key.')
  const missing = keys.filter((k) => !cols.includes(k))
  if (missing.length) throw new Error(`Key column ${missing.join(', ')} is not imported from the file.`)
  const typeOf = Object.fromEntries(cols.map((c, i) => [c, types[i] ?? '']))
  const keyOf = (r: CellValue[]): Record<string, CellValue> => Object.fromEntries(keys.map((k) => [k, r[cols.indexOf(k)]]))
  if (mode === 'delete') {
    const k0 = cols.indexOf(keys[0])
    const where = keys.length === 1
      ? `${qi(d, keys[0])} IN (${rows.map((r) => lit(d, r[k0], types[k0])).join(', ')})`
      : rows.map((r) => `(${keyWhere(d, keyOf(r), typeOf)})`).join(' OR ')
    return [`DELETE FROM ${qt(d, schema, table)} WHERE ${where}`]
  }
  const set = cols.filter((c) => !keys.includes(c))
  if (!set.length) throw new Error('Nothing to update: every imported column is a key column.')
  // shortcut: one UPDATE per row; fine for thousands of rows, a join against a VALUES list would be faster for millions
  return rows.map((r) => updateSql(d, schema, table, keyOf(r), Object.fromEntries(set.map((c) => [c, r[cols.indexOf(c)]])), typeOf).replace(/;$/, ''))
}
