// SQL text utilities: statement splitting, read-only classification, query params, result-tab names.
import type { Dialect } from './types'

export interface Stmt { sql: string; from: number; to: number }

/**
 * Split on `;` outside strings, quoted identifiers, comments and PG dollar-quoted bodies.
 * MySQL scripts may switch the terminator with a `DELIMITER $$` line (client syntax, never sent to the server).
 */
export function splitStatements(text: string, dialect: Dialect = 'postgres'): Stmt[] {
  const out: Stmt[] = []
  let start = 0
  let i = 0
  let delim = ';'
  const n = text.length
  const push = (end: number): void => {
    const raw = text.slice(start, end)
    if (stripComments(raw).trim()) {
      const lead = raw.length - raw.trimStart().length
      out.push({ sql: raw.trim(), from: start + lead, to: start + raw.trimEnd().length })
    }
  }
  while (i < n) {
    const c = text[i]
    const c2 = text[i + 1]
    if (dialect === 'mysql' && (i === 0 || text[i - 1] === '\n')) {
      const e = lineEnd(text, i)
      const m = /^\s*delimiter\s+(\S+)\s*$/i.exec(text.slice(i, e))
      if (m) { push(i); delim = m[1]; start = e + 1; i = e + 1; continue }
    }
    if (c === '-' && c2 === '-') { i = lineEnd(text, i); continue }
    if (c === '#' && dialect === 'mysql') { i = lineEnd(text, i); continue }
    if (c === '/' && c2 === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue }
    if (c === "'" || c === '"' || c === '`') { i = quoteEnd(text, i, c, dialect === 'mysql'); continue }
    if (c === '$' && dialect === 'postgres') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i))
      if (m) { const e = text.indexOf(m[0], i + m[0].length); i = e < 0 ? n : e + m[0].length; continue }
    }
    if (delim === ';' ? c === ';' : text.startsWith(delim, i)) { push(i); start = i + delim.length; i += delim.length; continue }
    i++
  }
  push(n)
  return out
}

const lineEnd = (t: string, i: number): number => { const e = t.indexOf('\n', i); return e < 0 ? t.length : e }

function quoteEnd(t: string, i: number, q: string, backslash: boolean): number {
  let j = i + 1
  while (j < t.length) {
    if (backslash && t[j] === '\\') { j += 2; continue }
    if (t[j] === q) { if (t[j + 1] === q) { j += 2; continue } return j + 1 }
    j++
  }
  return t.length
}

export const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(--|#)[^\n]*/g, ' ')

/** Statement under the caret (or the last one before it). */
export function statementAt(text: string, pos: number, dialect: Dialect = 'postgres'): Stmt | undefined {
  const all = splitStatements(text, dialect)
  return all.find((s) => pos >= s.from && pos <= s.to + 1) ?? [...all].reverse().find((s) => s.to < pos)
}

const READ_ONLY = /^(select|explain|show|describe|desc|values|table|with)\b/i
const WRITE_WORDS = /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke)\b/i

/** True for SELECT / EXPLAIN / SHOW-style statements (safe mode Alert 2 / Safe 2 let these through). */
export function isReadOnly(sql: string): boolean {
  const s = stripComments(sql).trim()
  if (!READ_ONLY.test(s)) return false
  // EXPLAIN ANALYZE executes the statement, in both `EXPLAIN ANALYZE x` and `EXPLAIN (ANALYZE, …) x` forms
  if (/^with\b/i.test(s) || /^explain\s+analy[sz]e/i.test(s) || /^explain\s*\([^)]*\banaly[sz]e\b/i.test(s)) return !WRITE_WORDS.test(s.replace(/'(?:[^']|'')*'/g, "''"))
  return true
}

export type ParamFormat = 'colon' | 'percent' | 'question' | 'dollarBrace' | 'dollar' | 'doubleBrace'

const PARAM_RE: Record<ParamFormat, RegExp> = {
  colon: /(?<![:\w]):([A-Za-z_]\w*)/g,
  percent: /%([A-Za-z_]\w*)%/g,
  question: /\?/g,
  dollarBrace: /\$\{([A-Za-z_]\w*)\}/g,
  dollar: /\$([A-Za-z_]\w*)/g,
  doubleBrace: /\{\{([A-Za-z_]\w*)\}\}/g
}

/** Mask quoted strings (keeping length) so params inside quotes are ignored. */
const maskQuotes = (s: string): string => s.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, (m) => ' '.repeat(m.length))

export function findParams(sql: string, fmt: ParamFormat, searchInQuotes = false): string[] {
  const src = searchInQuotes ? sql : maskQuotes(stripComments(sql))
  const names: string[] = []
  let k = 0
  for (const m of src.matchAll(PARAM_RE[fmt])) {
    const name = fmt === 'question' ? `?${++k}` : m[1]
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/** Textual substitution, values verbatim (the user adds quotes), like most SQL clients. */
export function applyParams(sql: string, fmt: ParamFormat, values: Record<string, string>, searchInQuotes = false): string {
  const masked = searchInQuotes ? sql : maskQuotes(sql)
  let k = 0
  let out = ''
  let last = 0
  for (const m of masked.matchAll(PARAM_RE[fmt])) {
    const name = fmt === 'question' ? `?${++k}` : m[1]
    if (!(name in values)) continue
    out += sql.slice(last, m.index) + values[name]
    last = (m.index ?? 0) + m[0].length
  }
  return out + sql.slice(last)
}

/** `-- name: X` / `label:` / `tab:` comment directly above a statement names its result tab. */
export function resultName(sql: string): string | undefined {
  const m = /^\s*--\s*(?:name|label|tab)\s*:\s*(.+)$/im.exec(sql)
  return m?.[1].trim()
}

export interface ChartDirective { type: 'bar' | 'line' | 'pie'; x?: string; y: string[] }

/** `-- lagoon barchart x: month, y: revenue` style directive (the prefix word is optional). */
export function chartDirective(sql: string): ChartDirective | undefined {
  const m = /--\s*(?:\w+\s+)?(bar|line|pie)chart\b([^\n]*)/i.exec(sql)
  if (!m) return
  const kv = [...m[2].matchAll(/(x|y|label|value)\s*:\s*([\w.]+)/gi)]
  const x = kv.find((k) => /^(x|label)$/i.test(k[1]))?.[2]
  const y = kv.filter((k) => /^(y|value)$/i.test(k[1])).map((k) => k[2])
  return { type: m[1].toLowerCase() as ChartDirective['type'], x, y }
}

/** Append LIMIT n to a SELECT that has none. */
export function withRowLimit(sql: string, limit: number | null | undefined): string {
  if (!limit) return sql
  const s = stripComments(sql).trim()
  if (!/^(select|with)\b/i.test(s) || /\blimit\s+\d+/i.test(s) || /\bfetch\s+first\b/i.test(s)) return sql
  return sql.replace(/;\s*$/, '') + ` LIMIT ${limit}`
}
