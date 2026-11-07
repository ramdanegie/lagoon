// Snippet library plus the SQL-text helpers behind editor hover, ⌘-click and JOIN completion.
// Pure (type-only imports) so `node --test` can load it; settings and CodeMirror glue live in the screens.
import type { Dialect, ForeignKey } from '@shared/types'

/** Body uses CodeMirror snippet syntax: `${1:table}` fields (same number = edited together), `${}` = final cursor. */
export interface Snippet { id: string; name: string; prefix: string; body: string; dialects?: string[]; builtin?: boolean }

/** Settings key holding the user's snippets (array of Snippet). */
export const USER_SNIPPETS = 'snippets.user'

export const DIALECT_NAMES: Record<Dialect, string> = { postgres: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite' }

const b = (id: string, name: string, prefix: string, body: string, dialects?: Dialect[]): Snippet => ({ id: `builtin.${id}`, name, prefix, body, dialects, builtin: true })

export const BUILTIN_SNIPPETS: Snippet[] = [
  b('select', 'Select rows', 'sel', 'SELECT ${1:*}\nFROM ${2:table_name}\nWHERE ${3:condition}\nORDER BY ${4:id}\nLIMIT ${5:100};${}'),
  b('insert', 'Insert a row', 'ins', 'INSERT INTO ${1:table_name} (${2:column1}, ${3:column2})\nVALUES (${4:value1}, ${5:value2});${}'),
  b('update', 'Update with WHERE', 'upd', 'UPDATE ${1:table_name}\nSET ${2:column} = ${3:value}\nWHERE ${4:id} = ${5:1};${}'),
  b('join', 'Join two tables', 'jn', 'SELECT ${1:a}.*, ${2:b}.*\nFROM ${3:first_table} ${1:a}\nJOIN ${4:second_table} ${2:b} ON ${2:b}.${5:first_id} = ${1:a}.${6:id};${}'),
  b('cte', 'Common table expression', 'cte', 'WITH ${1:recent} AS (\n  SELECT ${2:*}\n  FROM ${3:table_name}\n  WHERE ${4:condition}\n)\nSELECT *\nFROM ${1:recent};${}'),
  b('case', 'CASE expression', 'cs', 'CASE\n  WHEN ${1:condition} THEN ${2:result}\n  ELSE ${3:fallback}\nEND${}'),
  b('upsert-pg', 'Upsert (ON CONFLICT)', 'ups', 'INSERT INTO ${1:table_name} (${2:id}, ${3:column})\nVALUES (${4:1}, ${5:value})\nON CONFLICT (${2:id}) DO UPDATE SET ${3:column} = EXCLUDED.${3:column};${}', ['postgres', 'sqlite']),
  b('upsert-my', 'Upsert (ON DUPLICATE KEY)', 'ups', 'INSERT INTO ${1:table_name} (${2:id}, ${3:column})\nVALUES (${4:1}, ${5:value})\nON DUPLICATE KEY UPDATE ${3:column} = VALUES(${3:column});${}', ['mysql']),
  b('index', 'Create index', 'cix', 'CREATE INDEX ${1:idx_name} ON ${2:table_name} (${3:column});${}'),
  b('index-pg', 'Create index concurrently', 'cixc', 'CREATE INDEX CONCURRENTLY ${1:idx_name} ON ${2:table_name} (${3:column});${}', ['postgres']),
  b('window', 'Window function', 'win', 'SELECT ${1:column},\n  ROW_NUMBER() OVER (PARTITION BY ${2:group_column} ORDER BY ${3:order_column}) AS ${4:rn}\nFROM ${5:table_name};${}'),
  b('tx', 'Transaction block', 'tx', 'BEGIN;\n${1:-- statements}\nCOMMIT;${}', ['postgres', 'sqlite']),
  b('tx-my', 'Transaction block', 'tx', 'START TRANSACTION;\n${1:-- statements}\nCOMMIT;${}', ['mysql'])
]

export const snippetFits = (s: Snippet, dialect: string): boolean => !s.dialects?.length || s.dialects.includes(dialect)

/** Built-ins first, then the user's; `dialect` undefined = every dialect. */
export const allSnippets = (user: Snippet[], dialect?: string): Snippet[] => [...BUILTIN_SNIPPETS, ...user].filter((s) => !dialect || snippetFits(s, dialect))

// ---------- identifiers and table scope ----------
const unquote = (s: string): string => s.replace(/^["`[](.*)["`\]]$/, '$1')
const PART = /[\w$]+|"[^"]*"|`[^`]*`/g

export interface Ident { from: number; to: number; parts: string[]; part: number }

/** The (possibly qualified, quoted) identifier under `col` in a line of text; `part` is the hovered segment. */
export function identAt(line: string, col: number): Ident | null {
  for (const m of line.matchAll(/(?:[\w$]+|"[^"]*"|`[^`]*`)(?:\.(?:[\w$]+|"[^"]*"|`[^`]*`))*/g)) {
    const start = m.index ?? 0
    if (col < start || col > start + m[0].length) continue
    const parts = [...m[0].matchAll(PART)]
    const i = parts.findIndex((p) => col >= start + (p.index ?? 0) && col <= start + (p.index ?? 0) + p[0].length)
    if (i < 0 || /^\d/.test(parts[i][0])) return null
    const from = start + (parts[i].index ?? 0)
    return { from, to: from + parts[i][0].length, parts: parts.map((p) => unquote(p[0])), part: i }
  }
  return null
}

export interface ScopeTable { schema?: string; name: string; alias?: string }

const NOT_ALIAS = new Set(['where', 'join', 'on', 'using', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'natural', 'group', 'order', 'limit', 'offset', 'having', 'union', 'set', 'values', 'window', 'lateral', 'as', 'straight_join', 'for', 'returning', 'except', 'intersect'])

/** Tables named after FROM / JOIN / UPDATE / INTO, with their aliases. */
// shortcut: comma-separated FROM lists only pick up the first table; parse the list if users rely on old-style joins
export function tablesInQuery(sql: string): ScopeTable[] {
  const clean = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/'(?:[^']|'')*'/g, "''")
  const out: ScopeTable[] = []
  const re = /\b(?:from|join|update|into)\s+((?:[\w$]+|"[^"]+"|`[^`]+`)(?:\.(?:[\w$]+|"[^"]+"|`[^`]+`))?)(?:\s+(?:as\s+)?([\w$]+))?/gi
  for (const m of clean.matchAll(re)) {
    const parts = [...m[1].matchAll(PART)].map((p) => unquote(p[0]))
    if (parts[0].toLowerCase() === 'select' || parts[0] === '') continue
    const alias = m[2] && !NOT_ALIAS.has(m[2].toLowerCase()) ? m[2] : undefined
    out.push(parts.length > 1 ? { schema: parts[0], name: parts[1], alias } : { name: parts[0], alias })
  }
  return out
}

/** Which table an identifier names, resolving aliases; null for columns (`alias.col`) and unknown shapes. */
export function tableOf(id: Ident, scope: ScopeTable[]): { schema?: string; name: string } | null {
  const lc = (s: string): string => s.toLowerCase()
  const byAlias = (n: string): ScopeTable | undefined => scope.find((t) => t.alias && lc(t.alias) === lc(n))
  const inScope = (n: string): boolean => !!byAlias(n) || scope.some((t) => lc(t.name) === lc(n))
  const { parts, part } = id
  if (parts.length > 2) return part === parts.length - 2 ? { schema: parts[part - 1], name: parts[part] } : null
  if (parts.length === 2 && part === 1) return inScope(parts[0]) ? null : { schema: parts[0], name: parts[1] }
  const t = byAlias(parts[part])
  return t ? { schema: t.schema, name: t.name } : { name: parts[part] }
}

/** Short alias for a table (order_items → oi), avoiding ones already used. */
export function aliasFor(table: string, used: string[]): string {
  const base = table.split(/[_\W]+/).filter(Boolean).map((w) => w[0]).join('').toLowerCase() || 't'
  const taken = new Set(used.map((u) => u.toLowerCase()))
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}${i}`)) i++
  return `${base}${i}`
}

/**
 * `<table> <alias> ON …` completions after JOIN, from foreign keys pointing out of or into the tables already
 * in scope. `fks` maps every known table of `schema` to its outgoing foreign keys.
 */
export function joinSuggestions(scope: ScopeTable[], fks: Map<string, ForeignKey[]>, schema?: string): string[] {
  const used = scope.map((t) => t.alias ?? t.name)
  const out = new Set<string>()
  const q = (s: string | undefined, n: string): string => (s && s !== schema ? `${s}.${n}` : n)
  const on = (a: string, ac: string[], bAlias: string, bc: string[]): string => ac.map((c, i) => `${a}.${c} = ${bAlias}.${bc[i]}`).join(' AND ')
  for (const t of scope) {
    if (t.schema && t.schema !== schema) continue
    const a = t.alias ?? t.name
    for (const fk of fks.get(t.name) ?? []) {
      const al = aliasFor(fk.refTable, used)
      out.add(`${q(fk.refSchema, fk.refTable)} ${al} ON ${on(al, fk.refColumns, a, fk.columns)}`)
    }
    for (const [src, list] of fks) {
      for (const fk of list) {
        if (fk.refTable !== t.name || (fk.refSchema && schema && fk.refSchema !== schema)) continue
        const al = aliasFor(src, used)
        out.add(`${src} ${al} ON ${on(al, fk.columns, a, fk.refColumns)}`)
      }
    }
  }
  return [...out]
}
