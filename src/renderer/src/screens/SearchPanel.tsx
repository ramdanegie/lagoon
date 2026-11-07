import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { FilterOp, ObjectKind } from '@shared/types'
import type { NameMode } from '@shared/dictionary'
import { call, errText, fail, on, uid } from '../lib/api'
import { useWs, openTab } from '../lib/ws'
import { Icon } from '../components/Icon'
import '../styles/admin.css'

const MATCH: [string, FilterOp][] = [['Contains', 'Contains'], ['Does not contain', 'Not contains'], ['Equals', '='], ['Starts with', 'Has prefix'], ['Ends with', 'Has suffix']]

interface Msg { searchId: string; schema?: string; table?: string; count?: number; error?: string; done?: number; total: number; finished?: boolean; stopped?: boolean }
interface Hit { schema: string; table: string; count: number }

/** Search in database, rendered in the left sidebar in place of the item tree: cell values (Data) or object names (Structure). */
export function SearchPanel({ onDone }: { onDone: () => void }): ReactNode {
  const [mode, setMode] = useState<'data' | 'structure'>('data')
  return (
    <div className="sp" aria-label="Search in database">
      <div className="row">
        <span className="section-title" style={{ padding: 0 }}>Search in database</span>
        <span className="grow" />
        <button className="btn sm" onClick={onDone}>Done</button>
      </div>
      <div className="seg" role="tablist" aria-label="Look in">
        {(['data', 'structure'] as const).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} className={`grow ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)}>{m === 'data' ? 'Data' : 'Structure'}</button>
        ))}
      </div>
      {mode === 'data' ? <DataSearch onDone={onDone} /> : <StructureSearch onDone={onDone} />}
    </div>
  )
}

/** Search cell values across tables of the current schema. */
function DataSearch({ onDone }: { onDone: () => void }): ReactNode {
  const sessionId = useWs((s) => s.sessionId)
  const schema = useWs((s) => s.schema)
  const objects = useWs((s) => s.objects)
  const tables = objects.filter((o) => o.kind === 'table')
  const [value, setValue] = useState('')
  const [op, setOp] = useState<FilterOp>('Contains')
  const [scope, setScope] = useState<'all' | 'some'>('all')
  const [picked, setPicked] = useState<string[]>([])
  const [find, setFind] = useState('')
  const [state, setState] = useState<'idle' | 'running' | 'paused' | 'done'>('idle')
  const [progress, setProgress] = useState({ done: 0, total: 0, stopped: false })
  const [hits, setHits] = useState<Hit[]>([])
  const [skipped, setSkipped] = useState<{ schema: string; table: string; error: string }[]>([])
  const job = useRef<{ id: string; op: FilterOp; value: string } | null>(null)

  useEffect(() => {
    const off = on('search:result', (m: Msg) => {
      if (m.searchId !== job.current?.id) return
      if (m.finished) { setState('done'); setProgress((p) => ({ ...p, stopped: !!m.stopped })); return }
      setProgress({ done: m.done ?? 0, total: m.total, stopped: false })
      if (m.error) setSkipped((s) => [...s, { schema: m.schema!, table: m.table!, error: m.error! }])
      else if (m.count) setHits((h) => [...h, { schema: m.schema!, table: m.table!, count: m.count! }])
    })
    return () => { off(); if (job.current) void call('search.stop', job.current.id) }
  }, [])

  const scoped = scope === 'all' ? tables : tables.filter((t) => picked.includes(t.name))
  const busy = state === 'running' || state === 'paused'

  const start = (): void => {
    if (!value || !scoped.length || busy) return
    job.current = { id: uid(), op, value }
    setHits([]); setSkipped([]); setProgress({ done: 0, total: scoped.length, stopped: false }); setState('running')
    call('search.start', sessionId, job.current.id, scoped.map((t) => ({ schema: t.schema, name: t.name })), op, value).catch((e) => { fail(e); setState('idle') })
  }
  const control = (what: 'pause' | 'resume' | 'stop'): void => {
    if (!job.current) return
    void call(`search.${what}`, job.current.id)
    if (what !== 'stop') setState(what === 'pause' ? 'paused' : 'running')
  }
  const open = (h: Hit): void => {
    const j = job.current!
    openTab({ kind: 'table', title: h.table, schema: h.schema, name: h.table, objKind: 'table', initialFilter: { column: '__any__', op: j.op, value: j.value } }, { newTab: true })
  }

  const schemas = [...new Set(hits.map((h) => h.schema))]
  const shown = tables.filter((t) => t.name.toLowerCase().includes(find.toLowerCase()))

  return (
    <>
      <input
        className="input"
        autoFocus
        placeholder="Value to find"
        aria-label="Value to find"
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') start(); if (e.key === 'Escape') onDone() }}
      />
      <select className="select" aria-label="Match type" value={op} disabled={busy} onChange={(e) => setOp(e.target.value as FilterOp)}>
        {MATCH.map(([label, v]) => <option key={v} value={v}>{label}</option>)}
      </select>
      <select className="select" aria-label="Tables to search" value={scope} disabled={busy} onChange={(e) => setScope(e.target.value as 'all' | 'some')}>
        <option value="all">All tables in {schema || 'this schema'}</option>
        <option value="some">Selected tables…</option>
      </select>
      {scope === 'some' && (
        <>
          <input className="input sm" placeholder="Filter tables" aria-label="Filter tables" value={find} onChange={(e) => setFind(e.target.value)} />
          <div className="sp-pick" role="group" aria-label="Tables to search">
            {shown.map((t) => (
              <label key={t.name} className="check">
                <input type="checkbox" disabled={busy} checked={picked.includes(t.name)} onChange={(e) => setPicked(e.target.checked ? [...picked, t.name] : picked.filter((p) => p !== t.name))} />
                <span className="ellipsis">{t.name}</span>
              </label>
            ))}
            {!shown.length && <span className="faint">No tables</span>}
          </div>
          <span className="sp-status">{picked.length} of {tables.length} selected</span>
        </>
      )}
      <div className="row">
        {state === 'running' ? <button className="btn grow" onClick={() => control('pause')}>Pause</button>
          : state === 'paused' ? <button className="btn grow" onClick={() => control('resume')}><Icon name="play" size={10} />Resume</button>
            : <button className="btn primary grow" disabled={!value || !scoped.length} onClick={start}><Icon name="search" size={12} />Start search</button>}
        {busy && <button className="btn" onClick={() => control('stop')}><Icon name="stop" size={10} />Stop</button>}
      </div>
      {state !== 'idle' && (
        <div className="sp-status" aria-live="polite">
          {progress.done} / {progress.total} tables{state === 'paused' ? ' · paused' : ''}{state === 'done' ? (progress.stopped ? ' · stopped' : ' · finished') : ''} · {hits.length} with matches
        </div>
      )}
      <div className="sp-results" role="list" aria-label="Search results">
        {schemas.map((sc) => (
          <div key={sc} role="group" aria-label={sc}>
            <div className="section-title">{sc}</div>
            {hits.filter((h) => h.schema === sc).map((h) => (
              <button key={h.table} role="listitem" className="list-item adm-item" title={`Open ${h.table} filtered to matching rows`} onClick={() => open(h)}>
                <Icon name="table" size={13} className="faint" />
                <span className="ellipsis">{h.table}</span>
                <span className="count">{h.count.toLocaleString()}</span>
              </button>
            ))}
          </div>
        ))}
        {state === 'done' && !hits.length && <div className="empty">No matches</div>}
        {skipped.length > 0 && (
          <details>
            <summary className="sp-status">{skipped.length} table{skipped.length > 1 ? 's' : ''} skipped</summary>
            {skipped.map((s) => <div key={s.schema + s.table} className="list-item danger-text" title={s.error}><span className="ellipsis">{s.table}: {s.error}</span></div>)}
          </details>
        )}
      </div>
    </>
  )
}

interface StructHit { kind: 'table' | 'view' | 'column' | 'index' | 'function'; name: string; objKind: ObjectKind; table?: string; inDefinition?: boolean }
const NAME_MODES: [NameMode, string][] = [['contains', 'Contains'], ['word', 'Whole word'], ['prefix', 'Starts with'], ['regex', 'Regular expression']]
const GROUPS: [StructHit['kind'], string][] = [['table', 'Tables'], ['view', 'Views'], ['column', 'Columns'], ['index', 'Indexes'], ['function', 'Functions']]

/** Search object names (and optionally view / function definitions) of the current schema. */
function StructureSearch({ onDone }: { onDone: () => void }): ReactNode {
  const sessionId = useWs((s) => s.sessionId)
  const schema = useWs((s) => s.schema)
  const [text, setText] = useState('')
  const [mode, setMode] = useState<NameMode>('contains')
  const [matchCase, setMatchCase] = useState(false)
  const [defs, setDefs] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hits, setHits] = useState<StructHit[] | null>(null)
  const [err, setErr] = useState('')

  const start = (): void => {
    if (!text || busy) return
    setBusy(true); setErr('')
    call<StructHit[]>('search.structure', sessionId, schema ?? '', text, mode, matchCase, defs)
      .then(setHits, (e) => { setHits(null); setErr(errText(e)) })
      .finally(() => setBusy(false))
  }
  const open = (h: StructHit): void => {
    const name = h.table ?? h.name
    if (h.kind === 'function') openTab({ kind: 'ddl', title: h.name, schema, name: h.name, objKind: h.objKind }, { newTab: true })
    else openTab({ kind: 'table', title: name, schema, name, objKind: h.objKind, view: h.kind === 'column' ? 'structure' : h.kind === 'index' ? 'index' : 'data' }, { newTab: true })
  }

  return (
    <>
      <input
        className="input"
        autoFocus
        placeholder="Name to find"
        aria-label="Name to find"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') start(); if (e.key === 'Escape') onDone() }}
      />
      <select className="select" aria-label="Match type" value={mode} onChange={(e) => setMode(e.target.value as NameMode)}>
        {NAME_MODES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>
      <label className="check"><input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Match case</label>
      <label className="check"><input type="checkbox" checked={defs} onChange={(e) => setDefs(e.target.checked)} /> Also search view and function definitions</label>
      <button className="btn primary" disabled={!text || busy} onClick={start}><Icon name="search" size={12} />{busy ? 'Searching…' : 'Search'}</button>
      {err && <div className="danger-text selectable sp-status">{err}</div>}
      {hits && <div className="sp-status" aria-live="polite">{hits.length ? `${hits.length} match${hits.length === 1 ? '' : 'es'} in ${schema || 'this schema'}` : 'No matches'}</div>}
      <div className="sp-results" role="list" aria-label="Search results">
        {GROUPS.map(([kind, label]) => {
          const list = (hits ?? []).filter((h) => h.kind === kind)
          return list.length > 0 && (
            <div key={kind} role="group" aria-label={label}>
              <div className="section-title">{label} <span className="faint">{list.length}</span></div>
              {list.map((h) => (
                <button key={`${h.table ?? ''}.${h.name}`} role="listitem" className="list-item adm-item" title={h.table ? `${h.table}.${h.name}` : h.name} onClick={() => open(h)}>
                  <Icon name={kind === 'column' ? 'columns' : kind === 'index' ? 'key' : h.objKind} size={13} className="faint" />
                  <span className="ellipsis">{h.name}</span>
                  {(h.table || h.inDefinition) && <span className="count">{h.inDefinition ? 'in definition' : h.table}</span>}
                </button>
              ))}
            </div>
          )
        })}
      </div>
    </>
  )
}
