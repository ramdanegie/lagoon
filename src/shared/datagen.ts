// Test data generation: per-column generators picked from name + type, a seeded RNG, FK ordering and the plan runner.
// The runner only needs a query function, so main (background job, preview, Copy as SQL) and node tests share it.
// Kept free of runtime imports besides other shared files so `node --test` can load it directly.
import type { Column, Dialect, Result } from './types'
import { qi, qt, insertSql, type CellValue } from './sqlgen'
import { insertManySql } from './importexport'

export type GenKind =
  | 'skip' | 'fk' | 'int' | 'decimal' | 'bool' | 'date' | 'datetime' | 'uuid' | 'email' | 'firstName' | 'lastName' | 'fullName'
  | 'username' | 'phone' | 'company' | 'city' | 'country' | 'street' | 'postcode' | 'url' | 'ip' | 'color'
  | 'words' | 'sentence' | 'paragraph' | 'enum' | 'list' | 'json' | 'pattern' | 'constant'

export interface ColGen {
  column: string
  type: string
  kind: GenKind
  nullPct: number // 0..100
  unique: boolean
  min?: string // number or date (int / decimal / date / datetime)
  max?: string
  scale?: number // decimals
  values?: string[] // enum / list
  text?: string // pattern / constant
  ref?: { schema: string; table: string; column: string } // fk
}
export interface TableGen { table: string; rows: number; columns: ColGen[] }
export interface GenPlan { schema: string; seed: number; deleteFirst: boolean; tables: TableGen[] }

export const GENERATORS: [GenKind, string][] = [
  ['skip', 'Skip (use default)'], ['fk', 'Existing value from referenced table'], ['int', 'Integer range'], ['decimal', 'Decimal range'],
  ['bool', 'Boolean'], ['date', 'Date range'], ['datetime', 'Date and time range'], ['uuid', 'UUID'], ['email', 'Email'],
  ['firstName', 'First name'], ['lastName', 'Last name'], ['fullName', 'Full name'], ['username', 'Username'], ['phone', 'Phone number'],
  ['company', 'Company'], ['city', 'City'], ['country', 'Country'], ['street', 'Street address'], ['postcode', 'Postcode'],
  ['url', 'URL'], ['ip', 'IP address'], ['color', 'Color'], ['words', 'Words'], ['sentence', 'Sentence'], ['paragraph', 'Paragraph'],
  ['enum', 'Enum values'], ['list', 'Custom list'], ['json', 'JSON object'], ['pattern', 'Pattern'], ['constant', 'Constant']
]

// ---------- random ----------
export type Rng = () => number
/** mulberry32: small, fast, good enough for fake data. */
export function rng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
/** FNV-1a: turns "seed:table" into a per-table seed, so a table's rows don't depend on the other tables. */
export function seedOf(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
const int = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1))
const pick = <T>(r: Rng, a: ArrayLike<T>): T => a[Math.floor(r() * a.length)]

// ---------- word lists (kept small on purpose) ----------
const FIRST = ['Ava', 'Liam', 'Mia', 'Noah', 'Zoe', 'Ethan', 'Lena', 'Omar', 'Iris', 'Hugo', 'Nora', 'Felix', 'Maya', 'Leo', 'Sara', 'Ivan', 'Aria', 'Theo', 'Yuki', 'Ravi']
const LAST = ['Smith', 'Garcia', 'Chen', 'Novak', 'Silva', 'Kim', 'Muller', 'Rossi', 'Okafor', 'Haddad', 'Larsen', 'Patel', 'Moreau', 'Tanaka', 'Kowalski', 'Reyes', 'Nguyen', 'Brown', 'Ivanova', 'Costa']
const CITY = ['Lisbon', 'Osaka', 'Denver', 'Lyon', 'Porto', 'Austin', 'Cork', 'Bergen', 'Tallinn', 'Leeds', 'Krakow', 'Perth', 'Quito', 'Accra', 'Malmo']
const COUNTRY = ['Portugal', 'Japan', 'United States', 'France', 'Ireland', 'Norway', 'Estonia', 'United Kingdom', 'Poland', 'Australia', 'Ecuador', 'Ghana', 'Sweden', 'Canada', 'Brazil']
const STREET = ['Oak', 'Maple', 'Harbor', 'Mill', 'Station', 'Church', 'Park', 'River', 'Hill', 'Garden', 'Lake', 'Market']
const SUFFIX = ['Street', 'Avenue', 'Road', 'Lane', 'Way']
const CO1 = ['Blue', 'North', 'Bright', 'Iron', 'Swift', 'Green', 'Silver', 'Prime', 'Cedar', 'Atlas']
const CO2 = ['Labs', 'Works', 'Systems', 'Foods', 'Logistics', 'Studio', 'Partners', 'Media', 'Energy', 'Health']
const CO3 = ['Inc', 'Ltd', 'LLC', 'Group', 'Co']
const COLOR = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'indigo', 'violet', 'black', 'white', 'gray', 'brown']
const DOMAIN = ['example.com', 'example.org', 'example.net', 'mail.test', 'corp.test']
const LOREM = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur'.split(' ')

// ---------- pattern (regex subset) ----------
type Atom = (r: Rng) => string
const DIG = '0123456789'
const UP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const LO = 'abcdefghijklmnopqrstuvwxyz'
const CLS: Record<string, string> = { d: DIG, w: UP + LO + DIG + '_', s: ' ' }

/** Compile a small regex subset into a string generator: literals, [A-Z0-9_] classes, \d \w \s, ".", (a|b) groups, ? * + {n} {m,n}. */
export function compilePattern(p: string): Atom {
  const src = p.replace(/^\^/, '').replace(/(?<!\\)\$$/, '')
  let i = 0
  const seq = (): Atom[][] => {
    const alts: Atom[][] = [[]]
    while (i < src.length && src[i] !== ')') {
      const c = src[i++]
      let atom: Atom
      if (c === '|') { alts.push([]); continue }
      if (c === '(') {
        if (src.startsWith('?:', i)) i += 2
        const inner = seq()
        i++ // ')'
        atom = (r) => pick(r, inner).map((f) => f(r)).join('')
      } else if (c === '[') {
        let set = ''
        while (i < src.length && src[i] !== ']') {
          let ch = src[i++]
          if (ch === '\\') { const e = src[i++] ?? ''; set += CLS[e] ?? e; continue }
          if (src[i] === '-' && src[i + 1] && src[i + 1] !== ']') {
            const to = src[i + 1]
            i += 2
            for (let k = ch.charCodeAt(0); k <= to.charCodeAt(0); k++) set += String.fromCharCode(k)
            ch = ''
          }
          set += ch
        }
        i++ // ']'
        atom = (r) => (set ? pick(r, set) : '')
      } else if (c === '\\') {
        const e = src[i++] ?? ''
        atom = CLS[e] ? (r) => pick(r, CLS[e]) : () => e
      } else if (c === '.') atom = (r) => pick(r, UP + LO + DIG)
      else atom = () => c
      let lo = 1
      let hi = 1
      const q = src[i]
      if (q === '?') { lo = 0; i++ } else if (q === '*') { lo = 0; hi = 5; i++ } else if (q === '+') { hi = 5; i++ } else if (q === '{') {
        const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i))
        if (m) { lo = Number(m[1]); hi = m[2] ? (m[3] ? Number(m[3]) : lo + 5) : lo; i += m[0].length }
      }
      const a = atom
      alts[alts.length - 1].push(lo === 1 && hi === 1 ? a : (r) => { let s = ''; for (let k = int(r, lo, Math.max(lo, hi)); k > 0; k--) s += a(r); return s })
    }
    return alts
  }
  const top = seq()
  return (r) => pick(r, top).map((f) => f(r)).join('')
}

// ---------- auto-assignment ----------
/** Character limit from varchar(n) / char(n) / character varying(n). */
export const maxLen = (type: string): number | undefined => {
  const m = /(char|binary)[^(]*\((\d+)\)/i.exec(type)
  return m ? Number(m[2]) : undefined
}

/** Largest absolute value a numeric type holds. `scale` is set for numeric(p,s); floats leave it open. */
function typeMax(type: string): { max: number; decimal: boolean; scale?: number } {
  const t = type.toLowerCase()
  const m = /(numeric|decimal|number)\s*\((\d+)\s*(?:,\s*(\d+))?\)/.exec(t)
  if (m) { const s = Number(m[3] ?? 0); return { max: 10 ** (Number(m[2]) - s) - 10 ** -s, decimal: s > 0, scale: s } }
  if (/tinyint/.test(t)) return { max: /unsigned/.test(t) ? 255 : 127, decimal: false }
  if (/smallint|int2/.test(t)) return { max: 32767, decimal: false }
  if (/mediumint/.test(t)) return { max: 8388607, decimal: false }
  if (/int|serial/.test(t)) return { max: 2147483647, decimal: false }
  return { max: 1e9, decimal: true } // numeric without precision, real, double, float, money
}

/** Values of `enum('a','b')` (MySQL column types). */
export const enumOfType = (type: string): string[] | undefined => {
  const m = /^enum\s*\((.*)\)$/is.exec(type.trim())
  return m ? [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'")) : undefined
}

/**
 * Column and allowed values from a CHECK clause such as `status IN ('a','b')`, Postgres'
 * `(status)::text = ANY (ARRAY['a'::text, ...])` or MySQL's `(`status` in (_utf8mb4'a',...))`.
 */
export function parseCheckIn(raw: string): { column: string; values: string[] } | null {
  const clause = raw.replace(/\\(['\\])/g, '$1') // MySQL's information_schema escapes quotes inside the clause
  const m = /[(\s`"[]*([A-Za-z_][\w$]*)[`"\]]*\)?(?:::[\w ]+?)?\)?\s+(?:in\s*\(|=\s*any\s*\()/i.exec(clause)
  if (!m) return null
  // values run to the first ")" outside quotes
  const list = /^(?:[^')]|'(?:[^']|'')*')*/.exec(clause.slice(m.index + m[0].length))![0]
  const values = [...list.matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'"))
  return values.length ? { column: m[1], values } : null
}

const NUM_TYPE = /^(small|big|tiny|medium)?int|integer|serial|numeric|decimal|real|double|float|number|money/i

/** A generator for a column, picked from its name, type, key and constraint info. */
export function autoGen(d: Dialect, c: Column, o: { ref?: ColGen['ref']; values?: string[]; unique?: boolean; self?: boolean } = {}): ColGen {
  const n = c.name.toLowerCase()
  const t = c.type.toLowerCase().trim()
  const g: ColGen = { column: c.name, type: c.type, kind: 'words', nullPct: 0, unique: !!o.unique || c.pk }
  const set = (kind: GenKind, extra: Partial<ColGen> = {}): ColGen => Object.assign(g, { kind }, extra)
  const auto = /auto_increment|identity|virtual generated|stored generated|^generated$/i.test(c.extra ?? '') || /serial/.test(t)
    || (c.pk && c.default !== null) || (d === 'sqlite' && c.pk && t === 'integer')
  if (auto) return set('skip', { unique: false })
  if (o.ref) return set('fk', { ref: o.ref, nullPct: o.self && c.nullable ? 50 : 0 })
  const values = o.values ?? enumOfType(c.type)
  if (values?.length) return set('enum', { values })
  if (/^(bool|boolean|tinyint\(1\)|bit(\(1\))?)$/.test(t)) return set('bool', { unique: false })
  if (t === 'uuid' || /^(uuid|guid)$/.test(n)) return set('uuid')
  if (/json/.test(t)) return set('json')
  if (t.endsWith('[]')) return set('constant', { text: '{}', unique: false })
  if (t === 'date') return set('date', { min: '2020-01-01', max: '2025-12-31' })
  if (/timestamp|datetime/.test(t)) return set('datetime', { min: '2020-01-01', max: '2025-12-31' })
  if (/^time\b/.test(t)) return set('pattern', { text: '([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d' })
  if (t === 'year') return set('int', { min: '1990', max: '2030' })
  if (/^(inet|cidr)$/.test(t)) return set('ip')
  if (/bytea|blob|binary|geometry|point|polygon|interval|xml|tsvector|macaddr|bit/.test(t))
    return c.nullable || c.default !== null ? set('skip', { unique: false }) : set('constant', { text: '', unique: false })
  if (NUM_TYPE.test(t)) {
    const tm = typeMax(t)
    const range = (lo: number, hi: number, scale = 2): ColGen => {
      const lim = { min: String(Math.max(lo, -tm.max)), max: String(Math.min(hi, tm.max)) }
      return tm.decimal ? set('decimal', { ...lim, scale: tm.scale ?? scale }) : set('int', lim)
    }
    if (/price|amount|cost|total|salary|balance|fee|revenue/.test(n)) return range(1, 1000, 2)
    if (/(^|_)age$/.test(n)) return range(18, 90)
    if (/qty|quantity|count|stock|units/.test(n)) return range(0, 500)
    if (/year/.test(n)) return range(1990, 2030)
    if (/(^|_)lat(itude)?$/.test(n)) return range(-90, 90, 6)
    if (/(^|_)(lng|lon|long|longitude)$/.test(n)) return range(-180, 180, 6)
    if (/rating|score|stars/.test(n)) return range(1, 5)
    if (/percent|pct/.test(n)) return range(0, 100)
    return range(tm.decimal ? 0 : 1, g.unique ? 1000000 : 1000)
  }
  // text
  const len = maxLen(c.type)
  if (len !== undefined && len <= 3) return set('pattern', { text: `[A-Z]{${len}}` }) // country / currency / flag codes
  if (/e_?mail/.test(n)) return set('email')
  if (/^(first_?name|fname|given_?name|forename)$/.test(n)) return set('firstName', { unique: false })
  if (/^(last_?name|lname|surname|family_?name)$/.test(n)) return set('lastName', { unique: false })
  if (/^(name|full_?name|display_?name|contact(_?name)?|customer_?name|author|owner_?name|person)$/.test(n)) return set('fullName')
  if (/user_?name|login|handle|nick/.test(n)) return set('username')
  if (/phone|mobile|(^|_)tel|fax|(^|_)cell/.test(n)) return set('phone')
  if (/company|organi[sz]ation|employer|^org$|business|vendor|supplier/.test(n)) return set('company')
  if (/city|town/.test(n)) return set('city')
  if (/country|nation/.test(n)) return set('country')
  if (/street|address|addr/.test(n)) return set('street')
  if (/zip|post_?code|postal/.test(n)) return set('postcode')
  if (/url|website|homepage|link|(^|_)uri$/.test(n)) return set('url')
  if (/(^|_)ip(_|$)|ip_?addr/.test(n)) return set('ip')
  if (/colou?r/.test(n)) return set('color')
  if (/^(title|subject|headline|summary|caption)$/.test(n)) return set('sentence')
  if (/desc|bio|body|content|note|comment|text|message|details|about/.test(n)) return set('paragraph')
  if (/(^|_)(code|sku|ref|reference|slug)$/.test(n)) return set('pattern', { text: '[A-Z]{3}-\\d{4}' })
  return set(len === undefined && /text|clob/.test(t) ? 'sentence' : 'words')
}

// ---------- values ----------
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
const words = (r: Rng, lo: number, hi: number): string => Array.from({ length: int(r, lo, hi) }, () => pick(r, LOREM)).join(' ')
const sentence = (r: Rng): string => cap(words(r, 4, 10)) + '.'
const pad = (n: number): string => String(n).padStart(2, '0')
const dayMs = 86400000
const toDate = (s: string | undefined, fallback: string): number => { const v = Date.parse((s || fallback).slice(0, 10) + 'T00:00:00Z'); return isNaN(v) ? Date.parse(fallback + 'T00:00:00Z') : v }

/** A value factory for one column. `pool` holds candidate values for fk columns. */
export function valueFn(g: ColGen, pool: unknown[] = []): (r: Rng) => CellValue {
  const hex = (r: Rng, n: number): string => Array.from({ length: n }, () => '0123456789abcdef'[int(r, 0, 15)]).join('')
  switch (g.kind) {
    case 'skip': return () => null
    case 'fk': return (r) => (pool.length ? (pick(r, pool) as CellValue) : null)
    case 'int': { const lo = Math.ceil(Number(g.min ?? 1)); const hi = Math.floor(Number(g.max ?? 1000)); return (r) => int(r, lo, Math.max(lo, hi)) }
    case 'decimal': { const lo = Number(g.min ?? 0); const hi = Number(g.max ?? 1000); const s = g.scale ?? 2; return (r) => Number((lo + r() * (hi - lo)).toFixed(s)) }
    case 'bool': return (r) => r() < 0.5
    case 'date':
    case 'datetime': {
      const a = toDate(g.min, '2020-01-01')
      const b = Math.max(a, toDate(g.max, '2025-12-31'))
      return (r) => {
        const d = new Date(a + Math.floor(r() * ((b - a) / dayMs + 1)) * dayMs + (g.kind === 'datetime' ? int(r, 0, 86399) * 1000 : 0))
        const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
        return g.kind === 'date' ? day : `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
      }
    }
    case 'uuid': return (r) => `${hex(r, 8)}-${hex(r, 4)}-4${hex(r, 3)}-${'89ab'[int(r, 0, 3)]}${hex(r, 3)}-${hex(r, 12)}`
    case 'email': return (r) => `${pick(r, FIRST)}.${pick(r, LAST)}${r() < 0.5 ? '' : int(r, 1, 999)}@${pick(r, DOMAIN)}`.toLowerCase()
    case 'firstName': return (r) => pick(r, FIRST)
    case 'lastName': return (r) => pick(r, LAST)
    case 'fullName': return (r) => `${pick(r, FIRST)} ${pick(r, LAST)}`
    case 'username': return (r) => `${pick(r, FIRST)}${pick(r, ['', '_', '.'])}${pick(r, LAST)}${int(r, 1, 999)}`.toLowerCase()
    case 'phone': return compilePattern('\\+1 \\d{3}-\\d{3}-\\d{4}')
    case 'company': return (r) => `${pick(r, CO1)} ${pick(r, CO2)}${r() < 0.5 ? ' ' + pick(r, CO3) : ''}`
    case 'city': return (r) => pick(r, CITY)
    case 'country': return (r) => pick(r, COUNTRY)
    case 'street': return (r) => `${int(r, 1, 9999)} ${pick(r, STREET)} ${pick(r, SUFFIX)}`
    case 'postcode': return (r) => String(int(r, 10000, 99999))
    case 'url': return (r) => `https://www.${pick(r, CO1)}${pick(r, CO2)}.test/${pick(r, LOREM)}-${int(r, 1, 999)}`.toLowerCase()
    case 'ip': return (r) => `${int(r, 1, 223)}.${int(r, 0, 255)}.${int(r, 0, 255)}.${int(r, 1, 254)}`
    case 'color': return (r) => pick(r, COLOR)
    case 'words': return (r) => words(r, 1, 3)
    case 'sentence': return sentence
    case 'paragraph': return (r) => Array.from({ length: int(r, 3, 5) }, () => sentence(r)).join(' ')
    case 'enum':
    case 'list': { const v = (g.values ?? []).map((x) => x.trim()).filter(Boolean); return (r) => (v.length ? pick(r, v) : null) }
    case 'json': return (r) => JSON.stringify({ id: int(r, 1, 9999), label: pick(r, LOREM), active: r() < 0.5, tags: [pick(r, LOREM), pick(r, LOREM)] })
    case 'pattern': return compilePattern(g.text ?? '')
    case 'constant': return () => g.text ?? ''
  }
}

const UNIQUE_TRIES = 200

/** `n` rows for the generated (non-skipped) columns. `seen` carries unique values across batches and existing rows. */
export function makeRows(t: TableGen, n: number, r: Rng, pools: Record<string, unknown[]> = {}, seen: Record<string, Set<string>> = {}): { columns: string[]; rows: CellValue[][] } {
  const cols = t.columns.filter((c) => c.kind !== 'skip')
  const fns = cols.map((c) => valueFn(c, pools[c.column]))
  const lens = cols.map((c) => maxLen(c.type))
  const rows: CellValue[][] = []
  for (let k = 0; k < n; k++) {
    rows.push(cols.map((c, i) => {
      if (c.nullPct > 0 && r() * 100 < c.nullPct) return null
      const one = (): CellValue => { const v = fns[i](r); return typeof v === 'string' && lens[i] ? v.slice(0, lens[i]) : v }
      if (!c.unique) return one()
      const s = (seen[c.column] ??= new Set())
      for (let tries = 0; tries < UNIQUE_TRIES; tries++) {
        const v = one()
        if (v === null) return v
        const key = String(v)
        if (!s.has(key)) { s.add(key); return v }
      }
      throw new Error(`${t.table}.${c.column}: ran out of unique values after ${s.size}. Widen the range or turn off Unique.`)
    }))
  }
  return { columns: cols.map((c) => c.column), rows }
}

/** Parents before children (by fk generators). Self-references and cycles don't block: those columns pick existing rows. */
export function fkOrder(tables: TableGen[], schema: string): TableGen[] {
  const names = new Set(tables.map((t) => t.table))
  const done: TableGen[] = []
  const left = [...tables]
  while (left.length) {
    const ready = left.findIndex((t) => t.columns.every((c) => c.kind !== 'fk' || !c.ref || c.ref.schema !== schema || c.ref.table === t.table || !names.has(c.ref.table) || done.some((x) => x.table === c.ref!.table)))
    done.push(left.splice(Math.max(0, ready), 1)[0])
  }
  return done
}

// ---------- runner ----------
export interface GenDb { dialect: Dialect; query: (sql: string) => Promise<Result> }
export interface GenHooks {
  execute: boolean // run the statements, or only collect them (Copy as SQL / preview)
  cancelled?: () => boolean
  progress?: (done: number, total: number, table: string) => void
  onRows?: (table: string, columns: string[], rows: CellValue[][]) => void
}

const BATCH = 500
const POOL = 10000

/** Generate every table of the plan in FK order. Returns the statements (also when executed) and the row count. */
export async function runPlan(db: GenDb, plan: GenPlan, h: GenHooks): Promise<{ sql: string[]; rows: number }> {
  const d = db.dialect
  const order = fkOrder(plan.tables.filter((t) => t.rows > 0), plan.schema)
  const sql: string[] = []
  const emit = async (s: string): Promise<void> => { sql.push(s); if (h.execute) await db.query(s) }
  const distinct = async (schema: string, table: string, col: string, limit: number): Promise<unknown[]> =>
    (await db.query(`SELECT DISTINCT ${qi(d, col)} FROM ${qt(d, schema, table)} WHERE ${qi(d, col)} IS NOT NULL LIMIT ${limit}`)).rows.map((x) => x[0])
  // values generated per "table.column" in this run (only what children reference), used when not executing
  const made: Record<string, unknown[]> = {}
  const wanted = new Set(order.flatMap((t) => t.columns.flatMap((c) => (c.kind === 'fk' && c.ref && c.ref.schema === plan.schema ? [`${c.ref.table}.${c.ref.column}`] : []))))
  const total = order.reduce((a, t) => a + t.rows, 0)
  let done = 0

  if (plan.deleteFirst) {
    for (const t of [...order].reverse()) {
      // MySQL checks self-references row by row, so a parent row can't go before its children in one DELETE
      if (d === 'mysql') for (const c of t.columns) if (c.ref?.schema === plan.schema && c.ref.table === t.table) await emit(`UPDATE ${qt(d, plan.schema, t.table)} SET ${qi(d, c.column)} = NULL`)
      await emit(`DELETE FROM ${qt(d, plan.schema, t.table)}`)
    }
  }

  for (const t of order) {
    const r = rng(seedOf(`${plan.seed}:${t.table}`))
    const types = t.columns.filter((c) => c.kind !== 'skip').map((c) => c.type)
    const fkCols = t.columns.filter((c) => c.kind === 'fk' && c.ref)
    const pools: Record<string, unknown[]> = {}
    const loadPools = async (): Promise<void> => {
      for (const c of fkCols) {
        const ref = c.ref!
        // when only collecting SQL, rows that "delete first" would remove are not candidates
        const stale = !h.execute && plan.deleteFirst && ref.schema === plan.schema && order.some((x) => x.table === ref.table)
        const existing = stale ? [] : await distinct(ref.schema, ref.table, ref.column, POOL)
        pools[c.column] = h.execute ? existing : [...existing, ...(made[`${ref.table}.${ref.column}`] ?? [])].slice(-POOL)
      }
    }
    const seen: Record<string, Set<string>> = {}
    if (!plan.deleteFirst) for (const c of t.columns) if (c.unique && c.kind !== 'skip') seen[c.column] = new Set((await distinct(plan.schema, t.table, c.column, 100000)).map(String))
    await loadPools()
    const self = fkCols.some((c) => c.ref!.schema === plan.schema && c.ref!.table === t.table)
    for (let i = 0; i < t.rows; i += BATCH) {
      if (h.cancelled?.()) throw new Error('Cancelled')
      if (self && i > 0) await loadPools() // self-references can point at rows from earlier batches
      const n = Math.min(BATCH, t.rows - i)
      const { columns, rows } = makeRows(t, n, r, pools, seen)
      h.onRows?.(t.table, columns, rows)
      if (columns.length) await emit(insertManySql(d, plan.schema, t.table, columns, rows, types))
      else for (let k = 0; k < n; k++) await emit(insertSql(d, plan.schema, t.table, {}).replace(/;$/, ''))
      columns.forEach((c, ci) => {
        const key = `${t.table}.${c}`
        if (!h.execute && wanted.has(key)) (made[key] ??= []).push(...rows.map((x) => x[ci]).filter((v) => v !== null))
      })
      done += n
      h.progress?.(done, total, t.table)
    }
  }
  return { sql, rows: done }
}

/** One-line summaries for the safe-mode prompt. */
export function planSummary(d: Dialect, plan: GenPlan): string[] {
  const order = fkOrder(plan.tables.filter((t) => t.rows > 0), plan.schema)
  return [
    ...(plan.deleteFirst ? [...order].reverse().map((t) => `DELETE FROM ${qt(d, plan.schema, t.table)}`) : []),
    ...order.map((t) => `INSERT INTO ${qt(d, plan.schema, t.table)} … -- ${t.rows} generated row${t.rows === 1 ? '' : 's'}`)
  ]
}
