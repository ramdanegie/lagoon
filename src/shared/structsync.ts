// Structure synchronization (PostgreSQL, MySQL/MariaDB): schema model, compare, dependency ordering,
// the migration script for the target, and a small line diff for the side-by-side DDL view.
// Pure: main reads the catalogs into SchemaModel, the renderer diffs and builds the script.
import type { Dialect } from './types'
import { qi, qt, lit, dropIndexSql } from './sqlgen'

export type SyncDialect = Exclude<Dialect, 'sqlite'>

export interface SColumn {
  name: string
  type: string
  nullable: boolean
  default: string | null
  comment: string | null
  collation: string | null
  /** PG: 'serial' | 'identity' | 'identity always'. MySQL: EXTRA (auto_increment, on update …). */
  extra: string | null
  generated: string | null
  /** MySQL: the exact column line from SHOW CREATE TABLE. PG builds it from the fields. */
  def?: string
  /** PG serial: the owned sequence. */
  seq?: string
}
export type ConsKind = 'pk' | 'unique' | 'check' | 'exclude' | 'fk'
/** def: PG constraint body (pg_get_constraintdef); MySQL the full line from SHOW CREATE TABLE. */
export interface SConstraint { name: string; kind: ConsKind; def: string; columns: string[]; refTable?: string; refSchema?: string | null; refColumns?: string[] }
/** def: PG "USING btree (a) WHERE …"; MySQL the full KEY line. */
export interface SIndex { name: string; def: string; unique: boolean; columns: string[] }
export interface STable { name: string; columns: SColumn[]; constraints: SConstraint[]; indexes: SIndex[]; comment: string | null; collation: string | null; options: string | null }
export interface SView { name: string; def: string; materialized?: boolean; security?: string | null; check?: string | null }
/** def: the full CREATE statement with the schema qualifier removed. */
export interface SRoutine { name: string; kind: 'function' | 'procedure'; args: string; result: string | null; def: string }
export interface STrigger { name: string; table: string; def: string }
export interface SSequence { name: string; type: string; start: string; increment: string; min: string; max: string; cache: string; cycle: boolean }
export interface SEnum { name: string; values: string[] }
export interface SchemaModel {
  dialect: SyncDialect
  schema: string
  lowerCaseNames: number
  tables: STable[]
  views: SView[]
  routines: SRoutine[]
  triggers: STrigger[]
  sequences: SSequence[]
  enums: SEnum[]
}

export interface SyncOptions {
  tables: boolean; columns: boolean; pk: boolean; fks: boolean; indexes: boolean; constraints: boolean
  views: boolean; routines: boolean; triggers: boolean; sequences: boolean
  comments: boolean; defaults: boolean; collation: boolean
  drops: boolean; cascade: boolean; caseMode: 'server' | 'sensitive' | 'insensitive'
}
export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  tables: true, columns: true, pk: true, fks: true, indexes: true, constraints: true, views: true, routines: true, triggers: true, sequences: true,
  comments: true, defaults: true, collation: true, drops: false, cascade: false, caseMode: 'server'
}

export type ObjType = 'type' | 'sequence' | 'table' | 'view' | 'routine' | 'trigger'
export type Op = 'create' | 'alter' | 'drop' | 'same'
/** obj: the object a statement touches; a checked item's own statements replace `rebuild` ones for the same object. */
export interface SyncStmt { sql: string; phase: number; seq: number; obj?: string; rebuild?: boolean }
export interface DiffItem { id: string; type: ObjType; name: string; op: Op; details: string[]; src: string; dst: string; stmts: SyncStmt[] }

// Script order: drops that block changes first, creates in dependency order, alters, FKs, routines, views, triggers, object drops last.
const P = { dropTrigger: 10, dropView: 15, dropRoutine: 18, dropFk: 30, dropCons: 35, createType: 40, alterType: 45, createTable: 50, alterTable: 55, addCons: 60, addFk: 70, createRoutine: 78, createView: 80, createTrigger: 90, dropTable: 95, dropSeq: 96, dropType: 97 }

const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SERIAL: Record<string, string> = { integer: 'serial', bigint: 'bigserial', smallint: 'smallserial' }
const FLAGS_ALL: SyncOptions = { ...DEFAULT_SYNC_OPTIONS }
const CONS_ORDER: ConsKind[] = ['pk', 'unique', 'check', 'exclude', 'fk']

/** Names match case-insensitively when asked, or (server default) when either MySQL server folds table names. */
export function caseSensitive(o: SyncOptions, src: SchemaModel, dst: SchemaModel): boolean {
  if (o.caseMode !== 'server') return o.caseMode === 'sensitive'
  return src.dialect === 'postgres' || (!src.lowerCaseNames && !dst.lowerCaseNames)
}

/** Dependency order (dependencies first). Cycles are broken by skipping the back edge. */
export function topo(names: string[], deps: (n: string) => string[]): string[] {
  const out: string[] = []
  const state = new Map<string, number>()
  const set = new Set(names)
  const visit = (n: string): void => {
    if (state.get(n)) return
    state.set(n, 1)
    for (const d of deps(n)) if (set.has(d) && d !== n) visit(d)
    state.set(n, 2)
    out.push(n)
  }
  names.forEach(visit)
  return out
}

// shortcut: dependencies between views are found by name in the definition text; a false match only adds an ordering constraint
const mentions = (def: string, name: string, cs: boolean): boolean => new RegExp(`(^|[^\\w$])${esc(name)}([^\\w$]|$)`, cs ? '' : 'i').test(def)

function pair<T>(a: T[], b: T[], key: (x: T) => string): { both: [T, T][]; onlyA: T[]; onlyB: T[] } {
  const bm = new Map(b.map((x) => [key(x), x]))
  const ak = new Set(a.map(key))
  const both: [T, T][] = []
  const onlyA: T[] = []
  for (const x of a) { const y = bm.get(key(x)); if (y) both.push([x, y]); else onlyA.push(x) }
  return { both, onlyA, onlyB: b.filter((y) => !ak.has(key(y))) }
}

/** MySQL 8 dropped integer display widths; compare without them (tinyint(1) still means boolean). */
const normType = (d: SyncDialect, t: string): string =>
  d === 'mysql' ? t.toLowerCase().replace(/^(tinyint|smallint|mediumint|int|bigint)\((\d+)\)/, (m, b: string, n: string) => (b === 'tinyint' && n === '1' ? m : b)) : t

// ---------- DDL emitters ----------

export function columnSql(d: SyncDialect, c: SColumn): string {
  if (d === 'mysql') return c.def ?? `${qi(d, c.name)} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.default != null ? ` DEFAULT ${c.default}` : ''}`
  const serial = c.extra === 'serial' ? SERIAL[c.type] : undefined
  const ident = c.extra === 'identity always' ? ' GENERATED ALWAYS AS IDENTITY' : c.extra === 'identity' ? ' GENERATED BY DEFAULT AS IDENTITY' : ''
  return `${qi(d, c.name)} ${serial ?? c.type}${c.collation ? ` COLLATE ${qi(d, c.collation)}` : ''}${c.generated ? ` GENERATED ALWAYS AS (${c.generated}) STORED` : ''}${ident}${c.nullable ? '' : ' NOT NULL'}${c.default != null && !serial && !c.generated ? ` DEFAULT ${c.default}` : ''}`
}

const consOn = (k: ConsKind, o: SyncOptions): boolean => (k === 'pk' ? o.pk : k === 'fk' ? o.fks : o.constraints)
const consInline = (d: SyncDialect, c: SConstraint): string => (d === 'postgres' ? `CONSTRAINT ${qi(d, c.name)} ${c.def}` : c.def)
const addCons = (d: SyncDialect, s: string, t: string, c: SConstraint): string => `ALTER TABLE ${qt(d, s, t)} ADD ${consInline(d, c)};`
function dropCons(d: SyncDialect, s: string, t: string, c: SConstraint): string {
  const tt = qt(d, s, t)
  if (d === 'postgres') return `ALTER TABLE ${tt} DROP CONSTRAINT ${qi(d, c.name)};`
  if (c.kind === 'pk') return `ALTER TABLE ${tt} DROP PRIMARY KEY;`
  if (c.kind === 'fk') return `ALTER TABLE ${tt} DROP FOREIGN KEY ${qi(d, c.name)};`
  if (c.kind === 'unique') return `ALTER TABLE ${tt} DROP INDEX ${qi(d, c.name)};`
  return `ALTER TABLE ${tt} DROP CONSTRAINT ${qi(d, c.name)};`
}
const createIndex = (d: SyncDialect, s: string, t: string, ix: SIndex): string =>
  d === 'postgres' ? `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${qi(d, ix.name)} ON ${qt(d, s, t)} ${ix.def};` : `ALTER TABLE ${qt(d, s, t)} ADD ${ix.def};`
const consLabel = (c: SConstraint): string => (c.kind === 'pk' ? 'primary key' : `${{ unique: 'unique', check: 'check', exclude: 'exclusion', fk: 'foreign key' }[c.kind]} ${c.name}`)
const commentSql = (d: SyncDialect, what: string, v: string | null): string => `COMMENT ON ${what} IS ${v ? lit(d, v) : 'NULL'};`

/** CREATE TABLE plus (PG) its indexes and comments. FKs are inline only for the DDL view; the script adds them later. */
export function createTableSql(d: SyncDialect, s: string, t: STable, o: SyncOptions = FLAGS_ALL, inlineFks = true): string[] {
  const lines = t.columns.map((c) => '  ' + columnSql(d, c))
  const cons = [...t.constraints].sort((a, b) => CONS_ORDER.indexOf(a.kind) - CONS_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name))
  for (const c of cons) if (consOn(c.kind, o) && (c.kind !== 'fk' || inlineFks)) lines.push('  ' + consInline(d, c))
  if (d === 'mysql' && o.indexes) for (const ix of t.indexes) lines.push('  ' + ix.def)
  const out = [`CREATE TABLE ${qt(d, s, t.name)} (\n${lines.join(',\n')}\n)${d === 'mysql' && t.options ? ' ' + t.options : ''};`]
  if (d === 'postgres') {
    if (o.indexes) for (const ix of t.indexes) out.push(createIndex(d, s, t.name, ix))
    if (o.comments) {
      if (t.comment) out.push(commentSql(d, `TABLE ${qt(d, s, t.name)}`, t.comment))
      for (const c of t.columns) if (c.comment) out.push(commentSql(d, `COLUMN ${qt(d, s, t.name)}.${qi(d, c.name)}`, c.comment))
    }
  }
  return out
}

export function viewSql(d: SyncDialect, s: string, v: SView): string {
  if (d === 'postgres') return `CREATE ${v.materialized ? 'MATERIALIZED ' : ''}VIEW ${qt(d, s, v.name)} AS\n${v.def};`
  const check = v.check && v.check !== 'NONE' ? ` WITH ${v.check} CHECK OPTION` : ''
  return `CREATE ${v.security ? `SQL SECURITY ${v.security} ` : ''}VIEW ${qt(d, s, v.name)} AS ${v.def}${check};`
}
const dropViewSql = (d: SyncDialect, s: string, v: SView, cascade: boolean): string =>
  `DROP ${v.materialized ? 'MATERIALIZED ' : ''}VIEW IF EXISTS ${qt(d, s, v.name)}${cascade && d === 'postgres' ? ' CASCADE' : ''};`

const routineSql = (r: SRoutine): string => r.def.replace(/;?\s*$/, ';')
const dropRoutineSql = (d: SyncDialect, s: string, r: SRoutine, cascade: boolean): string =>
  d === 'postgres' ? `DROP ${r.kind.toUpperCase()} ${qt(d, s, r.name)}(${r.args})${cascade ? ' CASCADE' : ''};` : `DROP ${r.kind.toUpperCase()} IF EXISTS ${qt(d, s, r.name)};`
const triggerSql = (r: STrigger): string => r.def.replace(/;?\s*$/, ';')
const dropTriggerSql = (d: SyncDialect, s: string, r: STrigger): string =>
  d === 'postgres' ? `DROP TRIGGER IF EXISTS ${qi(d, r.name)} ON ${qt(d, s, r.table)};` : `DROP TRIGGER IF EXISTS ${qt(d, s, r.name)};`

const seqClauses = (q: SSequence): string => `AS ${q.type} INCREMENT BY ${q.increment} MINVALUE ${q.min} MAXVALUE ${q.max} START WITH ${q.start} CACHE ${q.cache}${q.cycle ? ' CYCLE' : ' NO CYCLE'}`
const enumSql = (d: SyncDialect, s: string, e: SEnum): string => `CREATE TYPE ${qt(d, s, e.name)} AS ENUM (${e.values.map((v) => lit(d, v)).join(', ')});`

// ---------- compare ----------

interface TableDiff { details: string[]; stmts: SyncStmt[]; touched: Set<string>; gone: Set<string>; keyCols: Set<string> }

function diffColumn(d: SyncDialect, o: SyncOptions, a: SColumn, b: SColumn): { changes: string[]; typeChanged: boolean } {
  const ch: string[] = []
  const typeDiff = normType(d, a.type) !== normType(d, b.type)
  const collDiff = (o.collation || d === 'postgres') && (a.collation ?? '') !== (b.collation ?? '')
  const genDiff = norm(a.generated) !== norm(b.generated)
  if (typeDiff) ch.push(`type ${b.type} → ${a.type}`)
  if (a.nullable !== b.nullable) ch.push(a.nullable ? 'allow NULL' : 'NOT NULL')
  if (o.defaults && norm(a.default) !== norm(b.default)) ch.push(`default ${b.default ?? 'none'} → ${a.default ?? 'none'}`)
  if (o.comments && (a.comment ?? '') !== (b.comment ?? '')) ch.push('comment')
  if (collDiff) ch.push(`collation ${b.collation ?? 'default'} → ${a.collation ?? 'default'}`)
  if (norm(a.extra) !== norm(b.extra)) ch.push(`${b.extra || 'plain'} → ${a.extra || 'plain'}`)
  if (genDiff) ch.push('generated expression')
  return { changes: ch, typeChanged: typeDiff || collDiff || genDiff }
}

/** Statements that turn target column b into source column a. */
function alterColumn(d: SyncDialect, o: SyncOptions, s: string, table: string, a: SColumn, b: SColumn): string[] {
  const tt = qt(d, s, table)
  if (d === 'mysql') return [`ALTER TABLE ${tt} MODIFY COLUMN ${columnSql(d, a)};`]
  const c = qi(d, b.name)
  const at = `ALTER TABLE ${tt} ALTER COLUMN ${c}`
  const comment = o.comments && (a.comment ?? '') !== (b.comment ?? '') ? [commentSql(d, `COLUMN ${tt}.${c}`, a.comment)] : []
  // generated columns hold derived data: recreate instead of altering
  if (norm(a.generated) !== norm(b.generated)) return [`ALTER TABLE ${tt} DROP COLUMN ${c};`, `ALTER TABLE ${tt} ADD COLUMN ${columnSql(d, a)};`, ...(a.comment && o.comments ? [commentSql(d, `COLUMN ${tt}.${c}`, a.comment)] : [])]
  const ident = (x: SColumn): boolean => !!x.extra?.startsWith('identity')
  const out: string[] = []
  if (ident(b) && !ident(a)) out.push(`${at} DROP IDENTITY IF EXISTS;`)
  if (b.extra === 'serial' && a.extra !== 'serial') out.push(`${at} DROP DEFAULT;`)
  const typeDiff = a.type !== b.type
  if (typeDiff || (a.collation ?? '') !== (b.collation ?? '')) out.push(`${at} TYPE ${a.type}${a.collation ? ` COLLATE ${qi(d, a.collation)}` : ''}${typeDiff ? ` USING ${c}::${a.type}` : ''};`)
  if (a.nullable !== b.nullable) out.push(`${at} ${a.nullable ? 'DROP' : 'SET'} NOT NULL;`)
  if (o.defaults && norm(a.default) !== norm(b.default)) out.push(a.default == null ? `${at} DROP DEFAULT;` : `${at} SET DEFAULT ${a.default};`)
  const gen = a.extra === 'identity always' ? 'ALWAYS' : 'BY DEFAULT'
  if (ident(a) && !ident(b)) out.push(`${at} ADD GENERATED ${gen} AS IDENTITY;`)
  else if (ident(a) && a.extra !== b.extra) out.push(`${at} SET GENERATED ${gen};`)
  if (a.extra === 'serial' && b.extra !== 'serial') {
    const seq = qt(d, s, a.seq ?? `${table}_${b.name}_seq`)
    out.push(`CREATE SEQUENCE IF NOT EXISTS ${seq} AS ${a.type} OWNED BY ${tt}.${c};`, `${at} SET DEFAULT nextval(${lit(d, seq)}::regclass);`, `SELECT setval(${lit(d, seq)}, COALESCE((SELECT MAX(${c}) FROM ${tt}), 0) + 1, false);`)
  }
  return [...out, ...comment]
}

function diffTable(d: SyncDialect, o: SyncOptions, s: string, k: (n: string) => string, t: STable, u: STable): TableDiff {
  const r: TableDiff = { details: [], stmts: [], touched: new Set(), gone: new Set(), keyCols: new Set() }
  const tt = qt(d, s, u.name)
  const add = (phase: number, sqls: string | string[], obj?: string): void => { for (const sql of ([] as string[]).concat(sqls)) r.stmts.push({ sql, phase, seq: 0, obj }) }
  const cascade = o.cascade && d === 'postgres' ? ' CASCADE' : ''

  if (o.columns) {
    const { both, onlyA, onlyB } = pair(t.columns, u.columns, (c) => k(c.name))
    for (const c of onlyA) {
      const i = t.columns.indexOf(c)
      const pos = d === 'mysql' ? (i === 0 ? ' FIRST' : ` AFTER ${qi(d, t.columns[i - 1].name)}`) : ''
      add(P.alterTable, [`ALTER TABLE ${tt} ADD COLUMN ${columnSql(d, c)}${pos};`, ...(d === 'postgres' && o.comments && c.comment ? [commentSql(d, `COLUMN ${tt}.${qi(d, c.name)}`, c.comment)] : [])])
      r.details.push(`add column ${c.name} ${c.type}`)
      if (d === 'postgres' && !c.nullable && c.default == null && !c.extra && !c.generated) r.details.push(`Warning: adding NOT NULL column ${c.name} without a default fails if the table has rows.`)
    }
    for (const [a, b] of both) {
      const { changes, typeChanged } = diffColumn(d, o, a, b)
      if (!changes.length) continue
      r.details.push(`change column ${b.name}: ${changes.join('; ')}`)
      add(P.alterTable, alterColumn(d, o, s, u.name, a, b))
      if (typeChanged) r.touched.add(k(b.name))
    }
    if (o.drops) {
      for (const c of onlyB) {
        add(P.alterTable, `ALTER TABLE ${tt} DROP COLUMN ${qi(d, c.name)}${cascade};`)
        r.details.push(`drop column ${c.name}`)
        r.gone.add(k(c.name))
        const like = onlyA.find((x) => normType(d, x.type) === normType(d, c.type))
        if (like) r.details.push(`Warning: ${c.name} → ${like.name} looks like a rename; this drops ${c.name} and its data.`)
      }
    }
  }

  const cons = (x: STable): SConstraint[] => x.constraints.filter((c) => consOn(c.kind, o))
  const { both, onlyA, onlyB } = pair(cons(t), cons(u), (c) => (c.kind === 'pk' ? '\0pk' : k(c.name)))
  const fkObj = (c: SConstraint): string | undefined => (c.kind === 'fk' ? `fk:${k(u.name)}.${k(c.name)}` : undefined)
  const keyed = (c: SConstraint): void => { if (c.kind === 'pk' || c.kind === 'unique') c.columns.forEach((x) => r.keyCols.add(k(x))) }
  for (const [a, b] of both) {
    if (norm(a.def) === norm(b.def)) continue
    add(b.kind === 'fk' ? P.dropFk : P.dropCons, dropCons(d, s, u.name, b), fkObj(b))
    add(a.kind === 'fk' ? P.addFk : P.addCons, addCons(d, s, u.name, a), fkObj(a))
    r.details.push(`change ${consLabel(a)}`)
    keyed(b)
  }
  for (const a of onlyA) { add(a.kind === 'fk' ? P.addFk : P.addCons, addCons(d, s, u.name, a), fkObj(a)); r.details.push(`add ${consLabel(a)}`) }
  if (o.drops) for (const b of onlyB) { add(b.kind === 'fk' ? P.dropFk : P.dropCons, dropCons(d, s, u.name, b), fkObj(b)); r.details.push(`drop ${consLabel(b)}`); keyed(b) }

  if (o.indexes) {
    const ix = pair(t.indexes, u.indexes, (x) => k(x.name))
    // MySQL needs an index behind every FK, so index changes on FK columns rebuild those FKs too
    const keyedIx = (x: SIndex): void => { if (d === 'mysql' || x.unique) x.columns.forEach((c) => r.keyCols.add(k(c))) }
    for (const [a, b] of ix.both) {
      if (norm(a.def) === norm(b.def) && a.unique === b.unique) continue
      add(P.dropCons, dropIndexSql(d, s, u.name, b.name))
      add(P.addCons, createIndex(d, s, u.name, a))
      r.details.push(`change index ${a.name}`)
      keyedIx(b)
    }
    for (const a of ix.onlyA) { add(P.addCons, createIndex(d, s, u.name, a)); r.details.push(`add index ${a.name}`) }
    if (o.drops) for (const b of ix.onlyB) { add(P.dropCons, dropIndexSql(d, s, u.name, b.name)); r.details.push(`drop index ${b.name}`); keyedIx(b) }
  }

  if (o.comments && (t.comment ?? '') !== (u.comment ?? '')) {
    add(P.alterTable, d === 'postgres' ? commentSql(d, `TABLE ${tt}`, t.comment) : `ALTER TABLE ${tt} COMMENT = ${lit(d, t.comment ?? '')};`)
    r.details.push('table comment')
  }
  if (d === 'mysql' && o.collation && t.collation && t.collation !== u.collation) {
    add(P.alterTable, `ALTER TABLE ${tt} COLLATE = ${t.collation};`)
    r.details.push(`table collation ${u.collation ?? 'default'} → ${t.collation}`)
  }
  return r
}

/** Compare source with target. Items carry statements for the target dialect and schema. */
export function diffSchemas(src: SchemaModel, dst: SchemaModel, o: SyncOptions): DiffItem[] {
  const d = dst.dialect
  const s = dst.schema
  const cs = caseSensitive(o, src, dst)
  const k = (n: string): string => (cs ? n : n.toLowerCase())
  const cascade = o.cascade && d === 'postgres'
  const items: DiffItem[] = []
  const item = (type: ObjType, name: string, op: Op, srcDdl = '', dstDdl = '', details: string[] = [], stmts: SyncStmt[] = []): DiffItem => {
    const it: DiffItem = { id: `${type}:${type === 'routine' ? name : k(name)}`, type, name, op, details, src: srcDdl, dst: dstDdl, stmts }
    items.push(it)
    return it
  }
  const st = (sql: string, phase: number, seq = 0, obj?: string, rebuild?: boolean): SyncStmt => ({ sql, phase, seq, obj, rebuild })

  // ---- enum types (PG; they come with tables) ----
  if (o.tables && d === 'postgres') {
    const { both, onlyA, onlyB } = pair(src.enums, dst.enums, (e) => k(e.name))
    for (const e of onlyA) item('type', e.name, 'create', enumSql(d, '', e), '', [], [st(enumSql(d, s, e), P.createType)])
    for (const [a, b] of both) {
      if (a.values.join('\0') === b.values.join('\0')) { item('type', a.name, 'same', enumSql(d, '', a), enumSql(d, '', b)); continue }
      const stmts: SyncStmt[] = []
      const details: string[] = []
      a.values.forEach((v, i) => {
        if (b.values.includes(v)) return
        const where = i > 0 ? ` AFTER ${lit(d, a.values[i - 1])}` : b.values.length ? ` BEFORE ${lit(d, a.values.find((x) => b.values.includes(x)) ?? b.values[0])}` : ''
        stmts.push(st(`ALTER TYPE ${qt(d, s, b.name)} ADD VALUE ${lit(d, v)}${where};`, P.alterType))
        details.push(`add value ${v}`)
      })
      const kept = a.values.filter((v) => b.values.includes(v))
      if (b.values.some((v) => !a.values.includes(v)) || kept.join('\0') !== b.values.filter((v) => a.values.includes(v)).join('\0'))
        details.push('Warning: values were removed or reordered; PostgreSQL cannot do that in place, recreate the type by hand.')
      item('type', a.name, 'alter', enumSql(d, '', a), enumSql(d, '', b), details, stmts)
    }
    if (o.drops) for (const e of onlyB) item('type', e.name, 'drop', '', enumSql(d, '', e), [], [st(`DROP TYPE ${qt(d, s, e.name)}${cascade ? ' CASCADE' : ''};`, P.dropType)])
  }

  // ---- sequences (PG) ----
  if (o.sequences && d === 'postgres') {
    const ddl = (q: SSequence): string => `CREATE SEQUENCE ${qi(d, q.name)} ${seqClauses(q)};`
    const { both, onlyA, onlyB } = pair(src.sequences, dst.sequences, (q) => k(q.name))
    for (const q of onlyA) item('sequence', q.name, 'create', ddl(q), '', [], [st(`CREATE SEQUENCE ${qt(d, s, q.name)} ${seqClauses(q)};`, P.createType)])
    for (const [a, b] of both) {
      if (seqClauses(a) === seqClauses(b)) item('sequence', a.name, 'same', ddl(a), ddl(b))
      else item('sequence', a.name, 'alter', ddl(a), ddl(b), ['options'], [st(`ALTER SEQUENCE ${qt(d, s, b.name)} ${seqClauses(a)};`, P.alterType)])
    }
    if (o.drops) for (const q of onlyB) item('sequence', q.name, 'drop', '', ddl(q), [], [st(`DROP SEQUENCE ${qt(d, s, q.name)}${cascade ? ' CASCADE' : ''};`, P.dropSeq)])
  }

  // ---- tables ----
  const touched = new Map<string, Set<string>>()
  const gone = new Map<string, Set<string>>()
  const keyCols = new Map<string, Set<string>>()
  const tableItem = new Map<string, DiffItem>()
  const droppedTables = new Set<string>()
  if (o.tables) {
    const { both, onlyA, onlyB } = pair(src.tables, dst.tables, (t) => k(t.name))
    const byName = new Map(src.tables.map((t) => [k(t.name), t]))
    const order = topo(onlyA.map((t) => k(t.name)), (n) => (byName.get(n)?.constraints ?? []).filter((c) => c.kind === 'fk' && !c.refSchema).map((c) => k(c.refTable!)))
    for (const t of onlyA) {
      const seq = order.indexOf(k(t.name))
      const stmts = createTableSql(d, s, t, o, false).map((sql) => st(sql, P.createTable, seq))
      if (o.fks) for (const c of t.constraints) if (c.kind === 'fk') stmts.push(st(addCons(d, s, t.name, c), P.addFk, 0, `fk:${k(t.name)}.${k(c.name)}`))
      item('table', t.name, 'create', createTableSql(d, '', t).join('\n'), '', [], stmts)
    }
    for (const [t, u] of both) {
      const r = diffTable(d, o, s, k, t, u)
      const it = item('table', t.name, r.stmts.length || r.details.length ? 'alter' : 'same', createTableSql(d, '', t).join('\n'), createTableSql(d, '', u).join('\n'), r.details, r.stmts)
      tableItem.set(k(u.name), it)
      touched.set(k(u.name), r.touched)
      gone.set(k(u.name), r.gone)
      keyCols.set(k(u.name), r.keyCols)
    }
    if (o.drops) for (const u of onlyB) {
      tableItem.set(k(u.name), item('table', u.name, 'drop', '', createTableSql(d, '', u).join('\n'), [], [st(`DROP TABLE ${qt(d, s, u.name)}${cascade ? ' CASCADE' : ''};`, P.dropTable)]))
      droppedTables.add(k(u.name))
    }

    // FKs that block column type changes, key changes, column drops or table drops: drop first, re-add (as they are on the target) at the end
    const hits = (cols: string[] | undefined, set: Set<string> | undefined): boolean => !!set && !!cols?.some((c) => set.has(k(c)))
    for (const u of dst.tables) {
      const uk = k(u.name)
      if (droppedTables.has(uk)) continue
      for (const fk of u.constraints) {
        if (fk.kind !== 'fk') continue
        const rk = fk.refSchema ? undefined : k(fk.refTable!)
        const obj = `fk:${uk}.${k(fk.name)}`
        const drop = st(dropCons(d, s, u.name, fk), P.dropFk, 0, obj)
        if (rk && droppedTables.has(rk)) { tableItem.get(rk)!.stmts.push(drop); continue }
        const lost = hits(fk.columns, gone.get(uk)) ? uk : rk && hits(fk.refColumns, gone.get(rk)) ? rk : undefined
        if (lost) { tableItem.get(lost)!.stmts.push(drop); continue }
        const cause = hits(fk.columns, touched.get(uk)) || hits(fk.columns, keyCols.get(uk)) ? uk
          : rk && (hits(fk.refColumns, touched.get(rk)) || hits(fk.refColumns, keyCols.get(rk))) ? rk : undefined
        if (!cause) continue
        const it = tableItem.get(cause)!
        it.stmts.push({ ...drop, rebuild: true }, st(addCons(d, s, u.name, fk), P.addFk, 0, obj, true))
        if (!tableItem.get(uk)?.stmts.some((x) => x.obj === obj && !x.rebuild)) it.details.push(`rebuild foreign key ${u.name}.${fk.name} (it blocks the change)`)
      }
    }
  }

  // ---- views ----
  const allViews = [...new Set([...src.views, ...dst.views].map((v) => k(v.name)))]
  const viewDef = (n: string): string => [...src.views, ...dst.views].filter((v) => k(v.name) === n).map((v) => v.def).join('\n')
  const vorder = topo(allViews, (n) => allViews.filter((m) => m !== n && mentions(viewDef(n), m, cs)))
  const vseq = (v: SView): number => vorder.indexOf(k(v.name))
  const vobj = (v: SView): string => `view:${k(v.name)}`
  // PG refuses to change columns a view uses (and to drop a view others use): rebuild the dependent target views around the change
  const rebuildViews = (it: DiffItem, seeds: string[], why: string): void => {
    if (d !== 'postgres') return
    const hit = new Set(seeds)
    let grew = true
    while (grew) {
      grew = false
      for (const v of dst.views) if (!hit.has(k(v.name)) && [...hit].some((n) => mentions(v.def, n, cs))) { hit.add(k(v.name)); grew = true }
    }
    for (const v of dst.views) {
      if (!hit.has(k(v.name)) || seeds.includes(k(v.name))) continue
      it.stmts.push(st(dropViewSql(d, s, v, false), P.dropView, -vseq(v), vobj(v), true), st(viewSql(d, s, v), P.createView, vseq(v), vobj(v), true))
      it.details.push(`rebuild view ${v.name} (${why})`)
    }
  }
  for (const [uk, set] of touched) if (set.size || gone.get(uk)?.size) rebuildViews(tableItem.get(uk)!, [uk], 'it uses changed columns')
  if (o.views) {
    const { both, onlyA, onlyB } = pair(src.views, dst.views, (v) => k(v.name))
    for (const v of onlyA) item('view', v.name, 'create', viewSql(d, '', v), '', [], [st(viewSql(d, s, v), P.createView, vseq(v), vobj(v))])
    for (const [a, b] of both) {
      const same = norm(a.def) === norm(b.def) && !!a.materialized === !!b.materialized && (a.security ?? '') === (b.security ?? '') && (a.check ?? '') === (b.check ?? '')
      if (same) { item('view', a.name, 'same', viewSql(d, '', a), viewSql(d, '', b)); continue }
      const it = item('view', a.name, 'alter', viewSql(d, '', a), viewSql(d, '', b), ['definition'], [st(dropViewSql(d, s, b, false), P.dropView, -vseq(b), vobj(b)), st(viewSql(d, s, a), P.createView, vseq(a), vobj(a))])
      rebuildViews(it, [k(b.name)], `it uses ${b.name}`)
    }
    if (o.drops) for (const v of onlyB) item('view', v.name, 'drop', '', viewSql(d, '', v), [], [st(dropViewSql(d, s, v, cascade), P.dropView, -vseq(v), vobj(v))])
  }

  // ---- functions / procedures ----
  if (o.routines) {
    const rk = (r: SRoutine): string => `${k(r.name)}(${norm(r.args)})`
    const label = (r: SRoutine): string => (d === 'postgres' ? `${r.name}(${r.args})` : r.name)
    const { both, onlyA, onlyB } = pair(src.routines, dst.routines, rk)
    for (const r of onlyA) item('routine', label(r), 'create', routineSql(r), '', [], [st(routineSql(r), P.createRoutine)])
    for (const [a, b] of both) {
      if (norm(a.def) === norm(b.def)) { item('routine', label(a), 'same', routineSql(a), routineSql(b)); continue }
      // MySQL has no CREATE OR REPLACE for routines; PG cannot replace a different return type or kind
      const drop = d === 'mysql' || a.kind !== b.kind || norm(a.result) !== norm(b.result)
      item('routine', label(a), 'alter', routineSql(a), routineSql(b), ['definition'], [...(drop ? [st(dropRoutineSql(d, s, b, false), P.dropRoutine)] : []), st(routineSql(a), P.createRoutine)])
    }
    if (o.drops) for (const r of onlyB) item('routine', label(r), 'drop', '', routineSql(r), [], [st(dropRoutineSql(d, s, r, cascade), P.dropTable)])
  }

  // ---- triggers ----
  if (o.triggers) {
    const tk = (r: STrigger): string => (d === 'postgres' ? `${k(r.table)}.${k(r.name)}` : k(r.name))
    const label = (r: STrigger): string => `${r.table}.${r.name}`
    const { both, onlyA, onlyB } = pair(src.triggers, dst.triggers, tk)
    for (const r of onlyA) item('trigger', label(r), 'create', triggerSql(r), '', [], [st(triggerSql(r), P.createTrigger)])
    for (const [a, b] of both) {
      if (norm(a.def) === norm(b.def)) item('trigger', label(a), 'same', triggerSql(a), triggerSql(b))
      else item('trigger', label(a), 'alter', triggerSql(a), triggerSql(b), ['definition'], [st(dropTriggerSql(d, s, b), P.dropTrigger), st(triggerSql(a), P.createTrigger)])
    }
    if (o.drops) for (const r of onlyB) item('trigger', label(r), 'drop', '', triggerSql(r), [], [st(dropTriggerSql(d, s, r), P.dropTrigger)])
  }
  return items
}

/** The ordered migration script for the checked items, starting with the statement that points the session at the target schema. */
export function buildScript(items: DiffItem[], isChecked: (id: string) => boolean, dst: { dialect: SyncDialect; schema: string }): string[] {
  const sel = items.filter((i) => i.op !== 'same' && isChecked(i.id))
  const own = new Set(sel.flatMap((i) => i.stmts.filter((x) => !x.rebuild && x.obj).map((x) => x.obj)))
  const seen = new Set<string>()
  const list = sel.flatMap((i) => i.stmts).filter((x) => !(x.rebuild && own.has(x.obj)) && !seen.has(x.sql) && !!seen.add(x.sql))
  list.sort((a, b) => a.phase - b.phase || a.seq - b.seq)
  if (!list.length) return []
  // view, routine and trigger bodies name objects without a schema: resolve them in the target
  const head = dst.dialect === 'postgres' ? `SET search_path TO ${qi('postgres', dst.schema)};` : `USE ${qi('mysql', dst.schema)};`
  return [head, ...list.map((x) => x.sql)]
}

/** Script text; MySQL routine and trigger bodies are wrapped in DELIMITER so command-line clients accept them. */
export function scriptText(stmts: string[], d: SyncDialect): string {
  if (!stmts.length) return ''
  return stmts.map((x) => {
    const body = x.replace(/;\s*$/, '')
    return d === 'mysql' && /^CREATE\s+(FUNCTION|PROCEDURE|TRIGGER)\b/i.test(x) && body.includes(';') ? `DELIMITER $$\n${body}$$\nDELIMITER ;` : x
  }).join('\n\n') + '\n'
}

const NO_TX = /^\s*((CREATE|DROP)\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY|ALTER\s+TYPE\s[\s\S]*\sADD\s+VALUE\b|VACUUM\b|REINDEX\b[\s\S]*CONCURRENTLY|(CREATE|DROP|ALTER)\s+(DATABASE|TABLESPACE|SYSTEM)\b)/i

/** PG runs DDL transactionally unless a statement forbids it (enum ADD VALUE is unusable inside one). MySQL commits each DDL. */
export const canUseTransaction = (stmts: string[], d: SyncDialect): boolean => d === 'postgres' && !stmts.some((x) => NO_TX.test(x))

// ---------- MySQL SHOW CREATE TABLE ----------

const unq = (s: string): string => s.replace(/``/g, '`')
const idents = (s: string): string[] => [...s.matchAll(/`((?:[^`]|``)+)`/g)].map((m) => unq(m[1]))
const ID = '`((?:[^`]|``)+)`'

/** Split SHOW CREATE TABLE into column lines, keys, constraints and table options (AUTO_INCREMENT counter removed). */
export function parseMysqlCreateTable(sql: string): { columns: Map<string, string>; constraints: SConstraint[]; indexes: SIndex[]; options: string | null } {
  const columns = new Map<string, string>()
  const constraints: SConstraint[] = []
  const indexes: SIndex[] = []
  let options: string | null = null
  let m: RegExpExecArray | null
  for (const raw of sql.split('\n').slice(1)) {
    const line = raw.trim().replace(/,$/, '')
    if (line.startsWith('`')) columns.set(idents(line)[0], line)
    else if (line.startsWith(')')) { options = line.slice(1).replace(/\s*AUTO_INCREMENT=\d+/i, '').trim() || null; break }
    else if ((m = /^PRIMARY KEY \((.*)\)/.exec(line))) constraints.push({ name: 'PRIMARY', kind: 'pk', def: line, columns: idents(m[1]) })
    else if ((m = new RegExp(`^UNIQUE KEY ${ID} \\((.*)\\)`).exec(line))) constraints.push({ name: unq(m[1]), kind: 'unique', def: line, columns: idents(m[2]) })
    else if ((m = new RegExp(`^CONSTRAINT ${ID} FOREIGN KEY \\((.*?)\\) REFERENCES (?:${ID}\\.)?${ID} \\((.*?)\\)`).exec(line)))
      constraints.push({ name: unq(m[1]), kind: 'fk', def: line, columns: idents(m[2]), refSchema: m[3] ? unq(m[3]) : null, refTable: unq(m[4]), refColumns: idents(m[5]) })
    else if ((m = new RegExp(`^CONSTRAINT ${ID} CHECK `).exec(line))) constraints.push({ name: unq(m[1]), kind: 'check', def: line, columns: [] })
    else if ((m = new RegExp(`^(?:FULLTEXT |SPATIAL )?KEY ${ID} \\((.*)\\)`).exec(line))) indexes.push({ name: unq(m[1]), def: line, unique: false, columns: idents(m[2]) })
  }
  return { columns, constraints, indexes, options }
}

// ---------- line diff (side-by-side DDL view) ----------

/** same: both sides; change: line differs; src: only in source; dst: only in target. */
export interface DiffRow { kind: 'same' | 'change' | 'src' | 'dst'; left: string | null; right: string | null; ln: number | null; rn: number | null }

/** LCS line diff of source (left) and target (right), with adjacent removals and additions paired as changes. */
export function lineDiff(a: string, b: string): DiffRow[] {
  const A = a ? a.split('\n') : []
  const B = b ? b.split('\n') : []
  const n = A.length
  const m = B.length
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  let left: number[] = []
  let right: number[] = []
  const flush = (): void => {
    for (let x = 0; x < Math.max(left.length, right.length); x++) {
      const l = left[x]
      const r = right[x]
      rows.push({ kind: l !== undefined && r !== undefined ? 'change' : l !== undefined ? 'src' : 'dst', left: l !== undefined ? A[l] : null, right: r !== undefined ? B[r] : null, ln: l !== undefined ? l + 1 : null, rn: r !== undefined ? r + 1 : null })
    }
    left = []
    right = []
  }
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { flush(); rows.push({ kind: 'same', left: A[i], right: B[j], ln: i + 1, rn: j + 1 }); i++; j++ }
    else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) left.push(i++)
    else right.push(j++)
  }
  flush()
  return rows
}
