// Pure helpers for the Redis browser and MongoDB views (no window / React imports so node --test can load it).

// ---------- Redis ----------

/** One Redis command as a readable line (quotes args with spaces/quotes), for safe mode and the console. */
export const fmtCmd = (args: (string | number)[]): string =>
  args.map((a) => (typeof a === 'string' && (a === '' || /[\s"']/.test(a)) ? JSON.stringify(a) : String(a))).join(' ')

const REDIS_READ = new Set(
  ('GET MGET HGET HGETALL LRANGE SMEMBERS ZRANGE SCAN KEYS TYPE TTL PTTL EXISTS INFO DBSIZE XRANGE STRLEN HLEN LLEN SCARD ZCARD PING ' +
    'HKEYS HVALS HMGET HEXISTS HSTRLEN LINDEX SISMEMBER SRANDMEMBER ZSCORE ZRANK ZREVRANK ZREVRANGE ZRANGEBYSCORE ZCOUNT XLEN XREVRANGE ' +
    'SSCAN HSCAN ZSCAN GETRANGE ECHO TIME RANDOMKEY SELECT').split(' ')
)

/** True when the first word of a console line is a command that cannot change data. */
export const redisReadOnly = (line: string): boolean => REDIS_READ.has((line.trim().split(/\s+/)[0] ?? '').toUpperCase())

/** redis-cli style rendering: (nil), (integer) n, quoted strings, numbered nested arrays. */
export function renderRedis(v: unknown, indent = 0): string {
  if (v === null || v === undefined) return '(nil)'
  if (typeof v === 'number' || typeof v === 'bigint') return `(integer) ${v}`
  if (typeof v === 'string') return v.includes('\n') ? v.replace(/\r\n/g, '\n').trimEnd() : JSON.stringify(v)
  if (Array.isArray(v)) {
    if (!v.length) return '(empty array)'
    const w = String(v.length).length
    const pad = ' '.repeat(indent)
    return v.map((x, i) => `${i ? pad : ''}${String(i + 1).padStart(w)}) ${renderRedis(x, indent + w + 2)}`).join('\n')
  }
  return JSON.stringify(v)
}

/** Seconds → "no expiry" / "45s" / "12m 5s" / "3h 2m" / "2d 4h". */
export function fmtTtl(ttl: number): string {
  if (ttl === -1) return 'no expiry'
  if (ttl < 0) return 'expired'
  const d = Math.floor(ttl / 86400), h = Math.floor((ttl % 86400) / 3600), m = Math.floor((ttl % 3600) / 60), s = ttl % 60
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`
}

// ---------- MongoDB (documents arrive as relaxed EJSON, parsed with JSON.parse) ----------

export type Doc = Record<string, unknown>

const WRAPPERS = ['$oid', '$date', '$numberDecimal', '$numberLong', '$numberInt', '$numberDouble', '$binary', '$regularExpression', '$timestamp', '$minKey', '$maxKey', '$code', '$symbol']
const IDENT = /^[A-Za-z_$][\w$]*$/

/** An EJSON type wrapper such as {"$oid": "…"} (a leaf value, not a sub-document). */
export const isWrapper = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && WRAPPERS.includes(Object.keys(v)[0])

const dateIso = (d: unknown): string => {
  const ms = typeof d === 'string' ? Date.parse(d) : Number((d as { $numberLong?: string })?.$numberLong ?? d)
  return isNaN(ms) ? String(d) : new Date(ms).toISOString()
}

/** Shell-style literal: ObjectId("…"), ISODate("…"), unquoted identifier keys. Used for cells and previews. */
export function shell(v: unknown): string {
  if (v === undefined) return 'undefined'
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(shell).join(', ')}]`
  const o = v as Record<string, unknown>
  if (isWrapper(o)) {
    const k = Object.keys(o)[0]
    const x = o[k] as Record<string, unknown>
    switch (k) {
      case '$oid': return `ObjectId(${JSON.stringify(x)})`
      case '$date': return `ISODate(${JSON.stringify(dateIso(x))})`
      case '$numberDecimal': return `NumberDecimal(${JSON.stringify(x)})`
      case '$numberLong': return `NumberLong(${JSON.stringify(x)})`
      case '$numberInt': case '$numberDouble': return String(x)
      case '$binary': return `BinData(${parseInt(String(x.subType), 16) || 0}, ${JSON.stringify(x.base64)})`
      case '$regularExpression': return `/${x.pattern}/${x.options ?? ''}`
      case '$timestamp': return `Timestamp(${x.t}, ${x.i})`
    }
  }
  return `{${Object.entries(o).map(([k, x]) => `${IDENT.test(k) ? k : JSON.stringify(k)}: ${shell(x)}`).join(', ')}}`
}

/** Grid text for a field value. undefined = field missing in this document. */
export function cellText(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return v
  if (typeof v !== 'object') return String(v)
  const o = v as Record<string, unknown>
  if ('$date' in o && isWrapper(o)) return dateIso(o.$date)
  if (('$numberDecimal' in o || '$numberLong' in o) && isWrapper(o)) return String(o.$numberDecimal ?? o.$numberLong)
  return shell(v)
}

/** Short type label for the tree view. */
export function typeHint(v: unknown): string {
  if (v === null) return 'Null'
  if (Array.isArray(v)) return `Array[${v.length}]`
  if (typeof v === 'string') return 'String'
  if (typeof v === 'number') return Number.isInteger(v) ? 'Int' : 'Double'
  if (typeof v === 'boolean') return 'Boolean'
  if (isWrapper(v)) return ({ $oid: 'ObjectId', $date: 'Date', $numberDecimal: 'Decimal128', $numberLong: 'Long', $numberInt: 'Int', $numberDouble: 'Double', $binary: 'Binary', $regularExpression: 'Regex', $timestamp: 'Timestamp' } as Record<string, string>)[Object.keys(v)[0]] ?? 'Object'
  if (typeof v === 'object') return `Object{${Object.keys(v as object).length}}`
  return typeof v
}

const STR = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'`
const RELAX = new RegExp(String.raw`\b(ObjectId|ISODate|NumberLong|NumberDecimal|NumberInt)\(\s*(${STR}|-?\d+(?:\.\d+)?)?\s*\)|(${STR})|([A-Za-z_$][\w$]*)(\s*:)`, 'g')
const sq = (s: string): string => (s.startsWith("'") ? `"${s.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"` : s)

/** Shell-ish object text → strict JSON: quotes bare keys, single-quoted strings, ObjectId("…") → {"$oid": "…"} etc. */
export function relaxJson(s: string): string {
  return s.replace(RELAX, (m, fn?: string, arg?: string, str?: string, key?: string, colon?: string) => {
    if (str) return sq(str)
    if (key) return `${JSON.stringify(key)}${colon}`
    const a = arg ? (/^["']/.test(arg) ? (JSON.parse(sq(arg)) as string) : arg) : ''
    switch (fn) {
      case 'ObjectId': return JSON.stringify({ $oid: a })
      case 'ISODate': return JSON.stringify({ $date: a ? new Date(a).toISOString() : new Date().toISOString() })
      case 'NumberLong': return JSON.stringify({ $numberLong: a || '0' })
      case 'NumberDecimal': return JSON.stringify({ $numberDecimal: a || '0' })
      case 'NumberInt': return String(Number(a) || 0)
    }
    return m
  })
}

/** JSON.parse that also accepts shell-style literals (see relaxJson). Throws on invalid input. */
export function parseLoose(s: string): unknown {
  try { return JSON.parse(s) } catch { return JSON.parse(relaxJson(s)) }
}

/** Parse a filter/sort box: empty = {}, must be an object. Returns the error text instead of throwing. */
export function parseObject(s: string): { value: Doc } | { error: string } {
  if (!s.trim()) return { value: {} }
  try {
    const v = parseLoose(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? { value: v as Doc } : { error: 'Expected a JSON object, e.g. {"age": {"$gt": 30}}' }
  } catch (e) {
    return { error: `Invalid JSON: ${(e as Error).message}` }
  }
}

/**
 * Value for an edited grid cell. Numbers and booleans keep their type when the text allows it, strings stay
 * strings (no silent type change), dates accept any parseable date; anything else is parsed as JSON when it
 * parses and kept as a string otherwise.
 */
export function coerceCell(orig: unknown, text: string): unknown {
  const t = text.trim()
  if (typeof orig === 'number' && t !== '' && Number.isFinite(Number(t))) return Number(t)
  if (typeof orig === 'boolean' && /^(true|false)$/i.test(t)) return t.toLowerCase() === 'true'
  if (typeof orig === 'string') return text
  if (isWrapper(orig) && '$date' in orig && !/^[{[]/.test(t) && !/^ISODate/.test(t) && !isNaN(Date.parse(t))) return { $date: new Date(t).toISOString() }
  try { return parseLoose(t) } catch { return text }
}

/** Union of top-level keys over documents, _id first, then first-seen order. */
export function unionKeys(docs: Doc[]): string[] {
  const seen = new Set<string>(['_id'])
  for (const d of docs) for (const k of Object.keys(d)) seen.add(k)
  return docs.some((d) => '_id' in d) ? [...seen] : [...seen].slice(1)
}

/** `db.name` or `db.getCollection("weird name")`. */
export const collRef = (name: string): string => (IDENT.test(name) ? `db.${name}` : `db.getCollection(${JSON.stringify(name)})`)

export const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// ---------- Mongo shell text ----------

export interface Stmt { sql: string; from: number; to: number }

/**
 * Split shell code into statements: top-level `;`, or a top-level newline not followed by a `.` chain.
 * Comments are dropped from the statement text (a trailing // would swallow the driver's wrapper).
 */
export function splitJs(text: string): Stmt[] {
  const out: Stmt[] = []
  let start = 0, depth = 0, i = 0, chunk = 0, buf = ''
  const ws = /\s*/y
  const push = (end: number): void => {
    const sql = (buf + text.slice(chunk, end)).trim()
    if (sql) {
      const raw = text.slice(start, end)
      const from = start + raw.length - raw.trimStart().length
      out.push({ sql, from, to: start + raw.trimEnd().length })
    }
    buf = ''
  }
  while (i < text.length) {
    const c = text[i], n = text[i + 1]
    if (c === '/' && (n === '/' || n === '*')) {
      const e = n === '/' ? text.indexOf('\n', i) : text.indexOf('*/', i + 2)
      buf += text.slice(chunk, i) + ' '
      i = e < 0 ? text.length : n === '/' ? e : e + 2
      chunk = i
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      i++
      while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1
      i++
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1)
    else if (depth === 0 && (c === ';' || c === '\n')) {
      ws.lastIndex = i + 1
      ws.exec(text)
      if (c === ';' || text[ws.lastIndex] !== '.') { push(i); start = chunk = i + 1 }
    }
    i++
  }
  push(text.length)
  return out
}

/** Statement under the caret, or the last one before it. */
export function jsStatementAt(text: string, pos: number): Stmt | undefined {
  const all = splitJs(text)
  return all.find((s) => pos >= s.from && pos <= s.to + 1) ?? [...all].reverse().find((s) => s.to < pos) ?? all[0]
}

const READ_COLL = new RegExp(String.raw`^db\.(?:[A-Za-z_$][\w$]*|getCollection\(\s*(?:${STR})\s*\))\.(?:find|findOne|aggregate|count|countDocuments|estimatedDocumentCount|distinct|indexes|listIndexes|indexInformation|stats)\s*\(`)
const READ_DB = /^db\.(?:listCollections|stats)\s*\(/

/** Shell code that can only read: one find/aggregate/count/distinct… call, no $out/$merge, no callbacks. */
export function mongoShellReadOnly(code: string): boolean {
  const s = code.trim()
  if ((s.match(/\bdb\s*\./g) ?? []).length !== 1) return false
  if (/\$out\b|\$merge\b|=>|\bfunction\b/.test(s)) return false
  return READ_COLL.test(s) || READ_DB.test(s)
}

const READ_CMDS = new Set(['find', 'aggregate', 'count', 'distinct', 'listcollections', 'listindexes', 'listdatabases', 'dbstats', 'collstats', 'serverstatus', 'buildinfo', 'ping', 'hello', 'ismaster', 'connectionstatus', 'hostinfo', 'explain', 'getparameter', 'currentop'])

/** Database command JSON whose first key is a read-only command (aggregate without $out/$merge). */
export function mongoCommandReadOnly(json: string): boolean {
  const r = parseObject(json)
  if ('error' in r) return false
  const k = Object.keys(r.value)[0]?.toLowerCase()
  return !!k && READ_CMDS.has(k) && !/\$out\b|\$merge\b/.test(json)
}

const COLL_METHODS = ['find', 'findOne', 'aggregate', 'countDocuments', 'estimatedDocumentCount', 'distinct', 'insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'bulkWrite', 'createIndex', 'dropIndex', 'indexes', 'drop', 'rename']
const DB_METHODS = ['getCollection', 'listCollections', 'createCollection', 'dropCollection', 'command', 'stats']

/** Completions after `db.` (collections + db methods) or `db.<coll>.` (collection methods). `from` is an index into `before`. */
export function mongoCompletions(before: string, collections: string[]): { from: number; options: { label: string; type: string; apply?: string }[] } | null {
  let m = new RegExp(String.raw`\bdb\.(?:[A-Za-z_$][\w$]*|getCollection\(\s*(?:${STR})\s*\))\.([\w$]*)$`).exec(before)
  if (m) return { from: before.length - m[1].length, options: COLL_METHODS.map((label) => ({ label, type: 'method' })) }
  m = /\bdb\.([\w$]*)$/.exec(before)
  if (m) {
    return {
      from: before.length - m[1].length,
      options: [
        ...collections.map((c) => ({ label: c, type: 'class', apply: IDENT.test(c) ? c : `getCollection(${JSON.stringify(c)})` })),
        ...DB_METHODS.map((label) => ({ label, type: 'function' }))
      ]
    }
  }
  return null
}
