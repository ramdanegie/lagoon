// Copy / export formats for grid rows.
import type { Dialect } from '@shared/types'
import { insertSql } from '@shared/sqlgen'
import { setting } from './api'

export type CopyFormat = 'plain' | 'json' | 'html' | 'markdown' | 'csv' | 'csvHeader' | 'insert'
export const COPY_FORMATS: { id: CopyFormat; label: string }[] = [
  { id: 'plain', label: 'Plain Text' },
  { id: 'json', label: 'JSON' },
  { id: 'html', label: 'HTML' },
  { id: 'markdown', label: 'Markdown Table' },
  { id: 'csv', label: 'CSV' },
  { id: 'csvHeader', label: 'CSV with Header' },
  { id: 'insert', label: 'SQL INSERT Statements' }
]

export interface CsvOpts { delimiter: string; quote: string; lineBreak: string; decimal: string; nullAsEmpty?: boolean; header?: boolean; breakToSpace?: boolean }

export const csvSettings = (): CsvOpts => ({
  delimiter: setting('csv.delimiter', ','),
  quote: setting('csv.quote', 'auto'),
  lineBreak: setting('csv.lineBreak', '\n'),
  decimal: setting('csv.decimal', '.')
})

export const display = (v: unknown): string => (v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v))

function csvCell(v: unknown, o: CsvOpts): string {
  if (v === null || v === undefined) return o.nullAsEmpty ? '' : 'NULL'
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  if (o.decimal !== '.' && typeof v === 'number') s = s.replace('.', o.decimal)
  if (o.breakToSpace) s = s.replace(/\r?\n/g, ' ')
  const q = o.quote === 'auto' ? '"' : o.quote
  const need = o.quote !== 'auto' || s.includes(o.delimiter) || s.includes('"') || /[\r\n]/.test(s) || s !== s.trim()
  return need && q ? q + s.split(q).join(q + q) + q : s
}

export function toCsv(cols: string[], rows: unknown[][], o: CsvOpts = csvSettings()): string {
  const lines = rows.map((r) => r.map((v) => csvCell(v, o)).join(o.delimiter))
  if (o.header) lines.unshift(cols.map((c) => csvCell(c, o)).join(o.delimiter))
  return lines.join(o.lineBreak)
}

/** Parse CSV/TSV text (auto-detects tab vs comma when delimiter is not given). */
export function parseCsv(text: string, delimiter?: string, quote = '"'): string[][] {
  const d = delimiter ?? (text.split('\n')[0].includes('\t') ? '\t' : ',')
  const out: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQ = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQ) {
      if (ch === quote && text[i + 1] === quote) { cell += quote; i++ } else if (ch === quote) inQ = false
      else cell += ch
    } else if (ch === quote && cell === '') inQ = true
    else if (ch === d) { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell); out.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row) }
  return out
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function formatRows(fmt: CopyFormat, cols: string[], rows: unknown[][], ctx?: { dialect: Dialect; schema: string; table: string }): string {
  switch (fmt) {
    case 'plain': return rows.map((r) => r.map(display).join('\t')).join('\n')
    case 'json': return JSON.stringify(rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? null]))), null, 2)
    case 'html': return `<table>\n<tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>\n${rows.map((r) => `<tr>${r.map((v) => `<td>${esc(display(v))}</td>`).join('')}</tr>`).join('\n')}\n</table>`
    case 'markdown': {
      const cell = (v: unknown): string => display(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')
      return [`| ${cols.map(cell).join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n')
    }
    case 'csv': return toCsv(cols, rows)
    case 'csvHeader': return toCsv(cols, rows, { ...csvSettings(), header: true })
    case 'insert': {
      const c = ctx ?? { dialect: 'postgres' as Dialect, schema: '', table: 'table_name' }
      return rows.map((r) => insertSql(c.dialect, c.schema, c.table, Object.fromEntries(cols.map((k, i) => [k, (r[i] ?? null) as string | null])))).join('\n')
    }
  }
}
