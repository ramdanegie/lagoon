// MongoDB collection tab: Data (editable grid with staged changes) / Json / Tree views over one page of documents.
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type { CellValue } from '@shared/sqlgen'
import { call, errText, fail, toast, useCommands } from '../lib/api'
import { bumpPending, busy, guard, registerTabApi, ws, type Tab, type TabApi } from '../lib/ws'
import { type Doc, cellText, coerceCell, collRef, isWrapper, parseObject, parseLoose, sameJson, shell, typeHint, unionKeys } from '../lib/nosql'
import { Grid, type GridColumn, type GridPending, type Sel } from '../components/Grid'
import { Icon } from '../components/Icon'
import { Modal, confirmDialog, menuAt } from '../components/ui'
import { CodeEditor } from './MongoQuery'
import { MongoPipeline } from './MongoPipeline'
import '../styles/nosql.css'

const PAGE = 300
type View = 'data' | 'json' | 'tree' | 'pipeline'
interface Pending { sets: Map<number, Doc>; deleted: Set<number>; inserts: Doc[] }
const EMPTY: Pending = { sets: new Map(), deleted: new Set(), inserts: [] }
const idJson = (d: Doc): string => JSON.stringify(d._id)
const range = (s: Sel | null, r: number): number[] => (s && r >= s.r0 && r <= s.r1 ? Array.from({ length: s.r1 - s.r0 + 1 }, (_, i) => s.r0 + i) : [r])

function previewLines(coll: string, docs: Doc[], p: Pending): string[] {
  const c = collRef(coll)
  const out = [...p.sets].map(([r, set]) => `${c}.updateOne({_id: ${shell(docs[r]._id)}}, {$set: ${shell(set)}})`)
  if (p.deleted.size) out.push(`${c}.deleteMany({_id: {$in: [${[...p.deleted].map((r) => shell(docs[r]._id)).join(', ')}]}})`)
  return [...out, ...p.inserts.map((d) => `${c}.insertOne(${shell(d)})`)]
}

export function MongoView({ tab }: { tab: Tab }): ReactNode {
  const coll = tab.name ?? tab.title
  const readOnly = tab.objKind === 'view'
  const [docs, setDocs] = useState<Doc[]>([])
  const [total, setTotal] = useState(0)
  const [skip, setSkip] = useState(0)
  const [applied, setApplied] = useState({ filter: '{}', sort: '{}' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>('data')
  const [showFilter, setShowFilter] = useState(false)
  const [filterText, setFilterText] = useState('')
  const [sortText, setSortText] = useState('')
  const [inputErr, setInputErr] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending>(EMPTY)
  const [sel, setSel] = useState<Sel | null>(null)
  const [adding, setAdding] = useState(false)
  const filterRef = useRef<HTMLInputElement>(null)
  const count = pending.sets.size + pending.deleted.size + pending.inserts.length

  const load = async (q = applied, sk = skip): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const r = await busy(call<{ docs: string[]; total: number }>('mongo.find', ws().sessionId, coll, q.filter, q.sort, sk, PAGE))
      setDocs(r.docs.map((d) => JSON.parse(d) as Doc))
      setTotal(r.total)
      setSkip(sk)
      setApplied(q)
      setPending(EMPTY)
    } catch (e) {
      setError(errText(e))
    } finally {
      setLoading(false)
    }
  }

  /** Run a reload-style action, asking first when staged changes would be lost. */
  const leave = async (f: () => unknown): Promise<void> => {
    if (count && !(await confirmDialog('Discard pending changes?', `${count} uncommitted change(s) will be lost.`, { ok: 'Discard', danger: true }))) return
    f()
  }

  const commit = async (): Promise<boolean> => {
    const lines = previewLines(coll, docs, pending)
    if (!lines.length || !(await guard(lines))) return false
    const sid = ws().sessionId
    const left: Pending = { sets: new Map(pending.sets), deleted: new Set(pending.deleted), inserts: [...pending.inserts] }
    try {
      for (const [r, set] of pending.sets) { await busy(call('mongo.update', sid, coll, idJson(docs[r]), JSON.stringify(set))); left.sets.delete(r) }
      if (pending.deleted.size) { await busy(call('mongo.remove', sid, coll, [...pending.deleted].map((r) => idJson(docs[r])))); left.deleted.clear() }
      for (const d of pending.inserts) { await busy(call('mongo.insert', sid, coll, JSON.stringify(d))); left.inserts.shift() }
    } catch (e) {
      fail(e)
      setPending(left) // keep what did not get applied
      return false
    }
    toast('Changes committed', 'success')
    await load()
    return true
  }

  // TabApi reads the latest render through a ref so the registered object never goes stale.
  const api = useRef<TabApi>(null!)
  api.current = { pendingCount: () => count, previewSql: () => previewLines(coll, docs, pending), commit, discard: () => setPending(EMPTY) }
  useEffect(() => {
    registerTabApi(tab.id, { pendingCount: () => api.current.pendingCount(), previewSql: () => api.current.previewSql(), commit: () => api.current.commit(), discard: () => api.current.discard() })
    return () => registerTabApi(tab.id, null)
  }, [tab.id])
  useEffect(() => bumpPending(), [pending])

  const reloadRef = useRef<() => void>(() => {})
  reloadRef.current = () => { if (!count) void load() }
  useEffect(() => {
    void load()
    const h = (): void => reloadRef.current()
    window.addEventListener('ws:reload', h)
    return () => window.removeEventListener('ws:reload', h)
  }, [])

  useEffect(() => { if (showFilter) filterRef.current?.focus() }, [showFilter])

  const all = useMemo(() => [...docs, ...pending.inserts], [docs, pending.inserts])
  const columns = useMemo<GridColumn[]>(() => unionKeys(all).map((name) => ({ name, pk: name === '_id', readOnly: name === '_id' })), [all])
  const rows = useMemo(() => all.map((d) => columns.map((c) => cellText(d[c.name]))), [all, columns])
  const gridPending = useMemo<GridPending>(() => {
    const idx = new Map(columns.map((c, i) => [c.name, i]))
    const edits = new Map([...pending.sets].map(([r, set]) => [r, new Map(Object.entries(set).map(([k, v]) => [idx.get(k) ?? -1, (cellText(v) ?? null) as CellValue]))]))
    return { edits, deleted: pending.deleted, insertedFrom: docs.length }
  }, [pending, columns, docs.length])
  const sort = useMemo(() => Object.entries(JSON.parse(applied.sort) as Record<string, number>).map(([column, d]) => ({ column, dir: (d === -1 ? 'DESC' : 'ASC') as 'ASC' | 'DESC' })), [applied.sort])

  const onEdit = (r: number, c: number, v: CellValue): void => {
    const key = columns[c].name
    const text = String(v ?? '')
    if (r >= docs.length) {
      const inserts = [...pending.inserts]
      const d = { ...inserts[r - docs.length] }
      if (d[key] === undefined && text === '') return
      d[key] = coerceCell(d[key], text)
      inserts[r - docs.length] = d
      setPending({ ...pending, inserts })
      return
    }
    const orig = docs[r][key]
    if (orig === undefined && text === '') return
    if (docs[r]._id === undefined) { toast('This document has no _id, so it cannot be edited here.', 'error'); return }
    const val = coerceCell(orig, text)
    const sets = new Map(pending.sets)
    const s = { ...sets.get(r) }
    if (sameJson(val, orig)) delete s[key]
    else s[key] = val
    if (Object.keys(s).length) sets.set(r, s)
    else sets.delete(r)
    setPending({ ...pending, sets })
  }

  const stageDelete = (list: number[]): void => {
    if (readOnly) return
    const deleted = new Set(pending.deleted)
    const sets = new Map(pending.sets)
    const dropIns = new Set(list.filter((r) => r >= docs.length).map((r) => r - docs.length))
    for (const r of list) {
      if (r >= docs.length || docs[r]._id === undefined) continue
      if (deleted.has(r)) deleted.delete(r)
      else { deleted.add(r); sets.delete(r) }
    }
    setPending({ sets, deleted, inserts: pending.inserts.filter((_, i) => !dropIns.has(i)) })
  }
  const stageInsert = (list: Doc[]): void => setPending({ ...pending, inserts: [...pending.inserts, ...list] })
  const duplicate = (list: number[]): void => stageInsert(list.map((r) => { const { _id: _drop, ...rest } = all[r]; return rest }))
  const selected = (): number[] => (sel ? range(sel, sel.r0) : [])

  const rowMenu = (e: React.MouseEvent, r: number): void => {
    const list = range(sel, r)
    menuAt(e, [
      { label: 'Copy as JSON', onClick: () => void navigator.clipboard.writeText(JSON.stringify(list.length === 1 ? all[list[0]] : list.map((i) => all[i]), null, 2)) },
      { label: list.length > 1 ? `Duplicate ${list.length} documents` : 'Duplicate document', disabled: readOnly, onClick: () => duplicate(list) },
      { sep: true },
      { label: list.length > 1 ? `Delete ${list.length} documents` : 'Delete document', danger: true, disabled: readOnly, onClick: () => stageDelete(list) }
    ])
  }

  const apply = (): void => {
    const f = parseObject(filterText)
    const s = parseObject(sortText)
    if ('error' in f || 'error' in s) { setInputErr('error' in f ? `Filter: ${f.error}` : `Sort: ${(s as { error: string }).error}`); return }
    setInputErr(null)
    void leave(() => load({ filter: JSON.stringify(f.value), sort: JSON.stringify(s.value) }, 0))
  }
  const sortBy = (col: string): void => {
    const cur = (JSON.parse(applied.sort) as Record<string, number>)[col]
    const next = { [col]: cur === 1 ? -1 : 1 }
    void leave(() => { setSortText(shell(next)); void load({ ...applied, sort: JSON.stringify(next) }, 0) })
  }

  useCommands(`mongo:${tab.id}`, {
    'edit.addRow': () => (ws().active === tab.id && !readOnly ? setAdding(true) : false),
    'edit.find': () => (ws().active === tab.id ? (setShowFilter(true), filterRef.current?.focus()) : false)
  })

  const from = docs.length ? skip + 1 : 0
  return (
    <div className="nosql">
      {showFilter && view !== 'pipeline' && (
        <div className="filters">
          <div className="filter-row">
            <label htmlFor={`mf-${tab.id}`} className="muted">Filter</label>
            <input id={`mf-${tab.id}`} ref={filterRef} className="input mono grow" placeholder='{"age": {"$gt": 30}}' value={filterText} onChange={(e) => { setFilterText(e.target.value); setInputErr(null) }} onKeyDown={(e) => e.key === 'Enter' && apply()} aria-invalid={!!inputErr} />
            <label htmlFor={`ms-${tab.id}`} className="muted">Sort</label>
            <input id={`ms-${tab.id}`} className="input mono" style={{ width: 200 }} placeholder='{"age": -1}' value={sortText} onChange={(e) => { setSortText(e.target.value); setInputErr(null) }} onKeyDown={(e) => e.key === 'Enter' && apply()} aria-invalid={!!inputErr} />
            <button className="btn primary" onClick={apply}>Apply</button>
            <button className="btn ghost" onClick={() => { setFilterText(''); setSortText(''); setInputErr(null); void leave(() => load({ filter: '{}', sort: '{}' }, 0)) }}>Clear</button>
          </div>
          {inputErr && <div className="danger-text" role="alert" style={{ fontSize: 'var(--fs-sm)' }}>{inputErr}</div>}
        </div>
      )}
      {error && <div className="nosql-error" role="alert">{error}</div>}
      <div className="nosql-pane grow" style={{ display: view === 'data' ? 'flex' : 'none' }}>
        <Grid
          columns={columns}
          rows={rows}
          pending={gridPending}
          editable={!readOnly}
          sort={sort}
          rowOffset={skip}
          onEdit={onEdit}
          onSelect={setSel}
          onHeaderClick={sortBy}
          onCellMenu={(e, r) => rowMenu(e, r)}
          onKey={(e, s) => { if ((e.key === 'Delete' || e.key === 'Backspace') && s) { stageDelete(range(s, s.r0)); return true } return false }}
          empty={loading ? 'Loading…' : applied.filter !== '{}' ? 'No documents match the filter' : 'This collection is empty'}
        />
      </div>
      {view === 'json' && <JsonView coll={coll} docs={docs} blocked={count > 0 || readOnly} onSaved={() => void load()} />}
      {view === 'tree' && <TreeView docs={docs} />}
      <MongoPipeline coll={coll} visible={view === 'pipeline'} />
      <div className="bottombar" role="toolbar" aria-label="Collection">
        <div className="seg" role="group" aria-label="View">
          {(['data', 'json', 'tree', 'pipeline'] as View[]).map((v) => <button key={v} className={view === v ? 'on' : ''} aria-pressed={view === v} onClick={() => setView(v)}>{v === 'data' ? 'Data' : v === 'json' ? 'Json' : v === 'tree' ? 'Tree' : 'Pipeline'}</button>)}
        </div>
        {view !== 'pipeline' && <>
        <button className="btn sm" disabled={readOnly} onClick={() => setAdding(true)}><Icon name="plus" size={11} />Add document</button>
        <button className="btn sm" disabled={readOnly || !sel || view !== 'data'} onClick={() => stageDelete(selected())}><Icon name="minus" size={11} />Delete</button>
        {count > 0 && <span className="muted">{count} pending</span>}
        <span className="grow" />
        <span className="muted" role="status">{loading ? 'Loading…' : `${from}–${skip + docs.length} of ${total}`}</span>
        <button className="btn sm icon" aria-label="Previous page" title="Previous page" disabled={loading || skip === 0} onClick={() => void leave(() => load(applied, Math.max(0, skip - PAGE)))}><Icon name="chevronLeft" size={11} /></button>
        <button className="btn sm icon" aria-label="Next page" title="Next page" disabled={loading || skip + docs.length >= total} onClick={() => void leave(() => load(applied, skip + PAGE))}><Icon name="chevronRight" size={11} /></button>
        <button className={`btn sm icon ${showFilter ? 'on' : ''}`} aria-label="Toggle filter" aria-pressed={showFilter} title="Filter" onClick={() => setShowFilter(!showFilter)}><Icon name="filter" size={11} /></button>
        <button className="btn sm icon" aria-label="Refresh" title="Refresh" disabled={loading} onClick={() => void leave(() => load())}><Icon name="refresh" size={11} /></button>
        </>}
      </div>
      {adding && <AddDocument onClose={() => setAdding(false)} onAdd={(d) => { stageInsert([d]); setAdding(false); setView('data') }} />}
    </div>
  )
}

function AddDocument({ onClose, onAdd }: { onClose: () => void; onAdd: (d: Doc) => void }): ReactNode {
  const [text, setText] = useState('{\n  \n}')
  const [err, setErr] = useState('')
  const add = (): void => {
    const r = parseObject(text)
    if ('error' in r) setErr(r.error)
    else onAdd(r.value)
  }
  return (
    <Modal
      title="Add document"
      onClose={onClose}
      width={620}
      footer={
        <>
          <span className="grow danger-text ellipsis" role="alert" title={err}>{err}</span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={add}>Add</button>
        </>
      }
    >
      <div className="muted" style={{ fontSize: 'var(--fs-sm)' }}>Extended JSON is accepted, e.g. {'{"_id": {"$oid": "…"}}'} or ObjectId("…"). The insert is staged until you commit.</div>
      <CodeEditor value={text} onChange={(v) => { setText(v); setErr('') }} lang="json" label="New document JSON" autoFocus style={{ height: 300, border: '1px solid var(--border)', borderRadius: 'var(--r-md)' }} />
    </Modal>
  )
}

function JsonView({ coll, docs, blocked, onSaved }: { coll: string; docs: Doc[]; blocked: boolean; onSaved: () => void }): ReactNode {
  const original = useMemo(() => JSON.stringify(docs, null, 2), [docs])
  const [draft, setDraft] = useState(original)
  const [err, setErr] = useState('')
  useEffect(() => { setDraft(original); setErr('') }, [original])

  const save = async (): Promise<void> => {
    let arr: unknown
    try { arr = parseLoose(draft) } catch (e) { setErr(`Invalid JSON: ${(e as Error).message}`); return }
    if (!Array.isArray(arr)) { setErr('Expected an array of documents'); return }
    const byId = new Map(docs.map((d) => [idJson(d), d]))
    const matched = (arr as Doc[]).filter((d) => d && typeof d === 'object' && d._id !== undefined && byId.has(idJson(d)))
    const changed = matched.filter((d) => !sameJson(d, byId.get(idJson(d))))
    const ignored = arr.length - matched.length
    const note = ignored ? ` ${ignored} document(s) without a matching _id were ignored.` : ''
    if (!changed.length) { toast(`No changes to save.${note}`); return }
    const lines = changed.map((d) => `${collRef(coll)}.replaceOne({_id: ${shell(d._id)}}, ${shell(d)})`)
    if (!(await guard(lines))) return
    let n = 0
    try {
      for (const d of changed) { await busy(call('mongo.replace', ws().sessionId, coll, idJson(d), JSON.stringify(d))); n++ }
    } catch (e) {
      fail(e) // keep the draft; replacing again is idempotent
      return
    }
    toast(`Replaced ${n} document(s).${note}`, 'success')
    onSaved()
  }

  const dirty = draft !== original
  return (
    <div className="nosql-pane grow">
      <CodeEditor value={draft} onChange={(v) => { setDraft(v); setErr('') }} lang="json" label="Documents JSON" style={{ flex: 1 }} />
      <div className="nosql-addbar">
        <span className={`grow ellipsis ${err ? 'danger-text' : 'muted'}`} role="status" style={{ fontSize: 'var(--fs-sm)' }}>
          {err || (blocked && dirty ? 'Commit or discard the grid changes before saving JSON edits.' : 'Edit documents and save; each changed document is replaced by _id.')}
        </span>
        <button className="btn sm" disabled={!dirty} onClick={() => setDraft(original)}>Revert</button>
        <button className="btn sm primary" disabled={!dirty || blocked} onClick={() => void save()}>Save changes</button>
      </div>
    </div>
  )
}

function TreeView({ docs }: { docs: Doc[] }): ReactNode {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (p: string): void => setOpen((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n })
  return (
    <div className="mongo-tree" role="tree" aria-label="Documents">
      {docs.length ? docs.map((d, i) => <TreeNode key={i} label={`${i + 1}  ${cellText(d._id) ?? ''}`} v={d} path={String(i)} open={open} toggle={toggle} />) : <div className="empty">No documents</div>}
    </div>
  )
}

function TreeNode({ label, v, path, open, toggle }: { label: string; v: unknown; path: string; open: Set<string>; toggle: (p: string) => void }): ReactNode {
  const branch = !!v && typeof v === 'object' && !isWrapper(v)
  const isOpen = open.has(path)
  const entries: [string, unknown][] = branch ? (Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v as Doc)) : []
  const text = typeof v === 'string' ? JSON.stringify(v) : branch ? shell(v).slice(0, 160) : String(cellText(v) ?? 'null')
  return (
    <div role="treeitem" aria-expanded={branch ? isOpen : undefined} aria-selected={false}>
      <div className="node">
        {branch ? <button aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${label}`} onClick={() => toggle(path)}><Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={11} /></button> : <span style={{ width: 16, flex: 'none' }} />}
        <span className="k">{label}</span>
        {!(branch && isOpen) && <span className="v">{text}</span>}
        <span className="t">{typeHint(v)}</span>
      </div>
      {branch && isOpen && (
        <div className="kids" role="group">
          {entries.map(([k, x]) => <TreeNode key={k} label={k} v={x} path={`${path}\u0000${k}`} open={open} toggle={toggle} />)}
        </div>
      )}
    </div>
  )
}
