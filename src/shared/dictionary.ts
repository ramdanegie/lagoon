// Schema metadata helpers: the data dictionary (HTML / Markdown) and the name matcher used by structure search.
// No runtime imports so `node --test` loads it directly.
import type { Column, Dialect, ForeignKey, Index } from './types'

export interface DictTable {
  name: string
  kind: 'table' | 'view' | 'matview'
  comment: string | null
  rows: number | null
  columns: Column[]
  indexes: Index[]
  fks: ForeignKey[]
  definition?: string
}
export interface Dict {
  connection: string
  database?: string
  schema: string
  dialect: Dialect
  generatedAt: string
  tables: DictTable[]
  views: DictTable[]
  routines: { name: string; kind: 'function' | 'procedure'; signature: string }[]
}

const fkOf = (t: DictTable, col: string): ForeignKey | undefined => t.fks.find((f) => f.columns.includes(col))
const refText = (f: ForeignKey, col: string): string => `${f.refTable}.${f.refColumns[f.columns.indexOf(col)] ?? ''}`
const keys = (t: DictTable, c: Column): string => [c.pk ? 'PK' : '', fkOf(t, c.name) ? `FK → ${refText(fkOf(t, c.name)!, c.name)}` : ''].filter(Boolean).join(', ')
const rowsText = (n: number | null): string => (n === null ? '' : `~${n.toLocaleString('en-US')}`)
const title = (d: Dict): string => `${d.database ?? d.schema}${d.database && d.schema && d.schema !== d.database ? ` · ${d.schema}` : ''}`
export const anchor = (kind: string, name: string): string => `${kind}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

// ---------- Markdown ----------
const mdCell = (s: unknown): string => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
const mdTable = (head: string[], rows: unknown[][]): string =>
  [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`)].join('\n')

export function dictMarkdown(d: Dict): string {
  const out: string[] = [`# Data dictionary: ${title(d)}`, '', `Connection: ${d.connection} · Generated ${d.generatedAt.slice(0, 19).replace('T', ' ')} UTC`, '']
  out.push('## Contents', '')
  for (const t of d.tables) out.push(`- [${t.name}](#${anchor('table', t.name)})`)
  for (const v of d.views) out.push(`- [${v.name}](#${anchor('view', v.name)}) (${v.kind === 'matview' ? 'materialized view' : 'view'})`)
  if (d.routines.length) out.push('- [Functions and procedures](#routines)')
  out.push('')
  const section = (t: DictTable, kind: 'table' | 'view'): void => {
    out.push(`<a id="${anchor(kind, t.name)}"></a>`, '', `## ${t.name}`, '')
    const meta = [kind === 'view' ? (t.kind === 'matview' ? 'Materialized view' : 'View') : 'Table', t.rows !== null ? `${rowsText(t.rows)} rows` : ''].filter(Boolean).join(' · ')
    out.push(meta, '')
    if (t.comment) out.push(t.comment, '')
    out.push(mdTable(['Column', 'Type', 'Null', 'Default', 'Key', 'Comment'], t.columns.map((c) => [c.name, c.type, c.nullable ? 'YES' : 'NO', c.default ?? '', keys(t, c), c.comment ?? ''])), '')
    if (t.indexes.length) out.push('**Indexes**', '', mdTable(['Name', 'Columns', 'Unique', 'Type'], t.indexes.map((i) => [i.name, i.columns.join(', '), i.primary ? 'PRIMARY' : i.unique ? 'YES' : 'NO', i.type ?? ''])), '')
    if (t.fks.length) out.push('**Foreign keys**', '', mdTable(['Name', 'Columns', 'References', 'On update', 'On delete'], t.fks.map((f) => [f.name, f.columns.join(', '), `${f.refTable} (${f.refColumns.join(', ')})`, f.onUpdate, f.onDelete])), '')
    if (t.definition) out.push('```sql', t.definition.trim(), '```', '')
  }
  d.tables.forEach((t) => section(t, 'table'))
  d.views.forEach((v) => section(v, 'view'))
  if (d.routines.length) out.push('<a id="routines"></a>', '', '## Functions and procedures', '', mdTable(['Kind', 'Signature'], d.routines.map((r) => [r.kind, r.signature])), '')
  return out.join('\n')
}

// ---------- HTML ----------
const esc = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const hTable = (head: string[], rows: string[][]): string =>
  `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`

const CSS = `
:root { color-scheme: light dark; --fg: #1d2330; --muted: #667085; --line: #e3e6ec; --head: #f5f7fa; --accent: #1b7f9c; --bg: #fff; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6e9ef; --muted: #98a2b3; --line: #2c333d; --head: #1b2027; --accent: #5cc3dd; --bg: #12161b; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: var(--fg); background: var(--bg); }
.wrap { display: grid; grid-template-columns: 240px 1fr; min-height: 100vh; }
nav { position: sticky; top: 0; height: 100vh; overflow: auto; padding: 24px 16px; border-right: 1px solid var(--line); font-size: 13px; }
nav h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 16px 0 6px; }
nav a { display: block; padding: 2px 6px; border-radius: 4px; color: var(--fg); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
nav a:hover { background: var(--head); }
main { padding: 32px 40px; max-width: 1100px; }
h1 { margin: 0 0 4px; font-size: 24px; }
.meta { color: var(--muted); margin-bottom: 32px; }
section { margin-bottom: 40px; scroll-margin-top: 16px; }
section h2 { font-size: 18px; margin: 0 0 4px; }
.kind { display: inline-block; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--accent); margin-right: 8px; }
.comment { margin: 6px 0 12px; }
h3 { font-size: 13px; color: var(--muted); margin: 16px 0 6px; font-weight: 600; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 5px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { background: var(--head); font-weight: 600; color: var(--muted); }
td.mono, code, pre { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; }
pre { background: var(--head); border: 1px solid var(--line); border-radius: 6px; padding: 12px; overflow: auto; white-space: pre-wrap; }
.key { color: var(--accent); font-weight: 600; white-space: nowrap; }
a { color: var(--accent); }
@media print { nav { display: none; } .wrap { display: block; } }
`

export function dictHtml(d: Dict): string {
  const link = (kind: string, name: string): string => `<a href="#${anchor(kind, name)}">${esc(name)}</a>`
  const section = (t: DictTable, kind: 'table' | 'view'): string => {
    const label = kind === 'view' ? (t.kind === 'matview' ? 'Materialized view' : 'View') : 'Table'
    const cols = t.columns.map((c) => {
      const f = fkOf(t, c.name)
      const key = [c.pk ? 'PK' : '', f ? `FK → ${link('table', f.refTable)}${esc('.' + (f.refColumns[f.columns.indexOf(c.name)] ?? ''))}` : ''].filter(Boolean).join(', ')
      return [`<code>${esc(c.name)}</code>`, `<code>${esc(c.type)}</code>`, c.nullable ? 'YES' : 'NO', c.default === null ? '' : `<code>${esc(c.default)}</code>`, `<span class="key">${key}</span>`, esc(c.comment)]
    })
    return `<section id="${anchor(kind, t.name)}">
<h2><span class="kind">${label}</span>${esc(t.name)}</h2>
${t.rows !== null ? `<div class="meta" style="margin:0">${esc(rowsText(t.rows))} rows</div>` : ''}
${t.comment ? `<p class="comment">${esc(t.comment)}</p>` : ''}
<h3>Columns</h3>${hTable(['Column', 'Type', 'Null', 'Default', 'Key', 'Comment'], cols)}
${t.indexes.length ? `<h3>Indexes</h3>${hTable(['Name', 'Columns', 'Unique', 'Type'], t.indexes.map((i) => [`<code>${esc(i.name)}</code>`, `<code>${esc(i.columns.join(', '))}</code>`, i.primary ? 'PRIMARY' : i.unique ? 'YES' : 'NO', esc(i.type)]))}` : ''}
${t.fks.length ? `<h3>Foreign keys</h3>${hTable(['Name', 'Columns', 'References', 'On update', 'On delete'], t.fks.map((f) => [`<code>${esc(f.name)}</code>`, `<code>${esc(f.columns.join(', '))}</code>`, `${link('table', f.refTable)} <code>(${esc(f.refColumns.join(', '))})</code>`, esc(f.onUpdate), esc(f.onDelete)]))}` : ''}
${t.definition ? `<h3>Definition</h3><pre>${esc(t.definition.trim())}</pre>` : ''}
</section>`
  }
  const nav = [
    d.tables.length ? `<h2>Tables (${d.tables.length})</h2>${d.tables.map((t) => link('table', t.name)).join('')}` : '',
    d.views.length ? `<h2>Views (${d.views.length})</h2>${d.views.map((v) => link('view', v.name)).join('')}` : '',
    d.routines.length ? `<h2>Routines</h2><a href="#routines">Functions and procedures (${d.routines.length})</a>` : ''
  ].join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Data dictionary · ${esc(title(d))}</title><style>${CSS}</style></head>
<body><div class="wrap"><nav aria-label="Table of contents">${nav}</nav><main>
<h1>Data dictionary: ${esc(title(d))}</h1>
<div class="meta">Connection ${esc(d.connection)} · ${d.tables.length} tables · ${d.views.length} views · ${d.routines.length} routines · generated ${esc(d.generatedAt.slice(0, 19).replace('T', ' '))} UTC</div>
${d.tables.map((t) => section(t, 'table')).join('\n')}
${d.views.map((v) => section(v, 'view')).join('\n')}
${d.routines.length ? `<section id="routines"><h2>Functions and procedures</h2>${hTable(['Kind', 'Signature'], d.routines.map((r) => [esc(r.kind), `<code>${esc(r.signature)}</code>`]))}</section>` : ''}
</main></div></body></html>
`
}

// ---------- structure search ----------
export type NameMode = 'contains' | 'word' | 'prefix' | 'regex'

/** Predicate for object names / definitions. Throws on an invalid regular expression. */
export function nameMatcher(text: string, mode: NameMode, matchCase: boolean): (s: string) => boolean {
  const lit = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const src = mode === 'regex' ? text : mode === 'prefix' ? `^${lit}` : mode === 'word' ? `(^|[^A-Za-z0-9_])${lit}($|[^A-Za-z0-9_])` : lit
  const re = new RegExp(src, matchCase ? '' : 'i')
  return (s) => re.test(s)
}
