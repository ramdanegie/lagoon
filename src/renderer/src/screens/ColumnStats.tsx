// Data profiling for one table: per column nulls, distinct values, min/max/average, text length and a histogram
// (numbers) or the most common values (everything else). Columns are profiled one at a time.
import { type ReactNode, useEffect, useState } from 'react'
import type { Column } from '@shared/types'
import type { ColumnProfile } from '@shared/profile'
import { call, errText } from '../lib/api'
import { useWs } from '../lib/ws'
import { Icon } from '../components/Icon'

const SAMPLE = 100000
const pct = (n: number, of: number): string => (of ? `${((n / of) * 100).toFixed(n && n < of / 1000 ? 2 : 1)}%` : '–')
const short = (v: number): string => (Math.abs(v) >= 1e6 || (v !== 0 && Math.abs(v) < 0.01) ? v.toExponential(2) : Number(v.toFixed(2)).toLocaleString())

export function ColumnStats({ schema, table, columns }: { schema: string; table: string; columns: Column[] }): ReactNode {
  const sessionId = useWs((s) => s.sessionId)
  const [sample, setSample] = useState<number | null>(SAMPLE)
  const [run, setRun] = useState(0)
  const [res, setRes] = useState<Record<string, ColumnProfile | string>>({})
  const [current, setCurrent] = useState<string | null>(null)

  useEffect(() => {
    if (!sessionId || !columns.length) return
    let live = true
    setRes({})
    void (async () => {
      for (const c of columns) {
        if (!live) return
        setCurrent(c.name)
        const r = await call<ColumnProfile>('db.profileColumn', sessionId, schema, table, c.name, c.type, sample).catch((e) => errText(e))
        if (live) setRes((x) => ({ ...x, [c.name]: r }))
      }
      if (live) setCurrent(null)
    })()
    return () => { live = false }
  }, [sessionId, schema, table, columns, sample, run])

  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <div className="stats-head">
        <label className="row" style={{ gap: 'var(--sp-2)' }}>
          Rows looked at
          <select className="select" style={{ width: 'auto' }} value={sample ?? 0} onChange={(e) => setSample(Number(e.target.value) || null)}>
            <option value={SAMPLE}>First {SAMPLE.toLocaleString()}</option>
            <option value={0}>Whole table</option>
          </select>
        </label>
        <button className="btn sm" disabled={!!current} onClick={() => setRun((n) => n + 1)}><Icon name="refresh" size={11} /> Refresh</button>
        <span className="grow" />
        <span className="muted" role="status">{current ? `Profiling ${current}… (${Object.keys(res).length + 1} of ${columns.length})` : `${columns.length} columns profiled`}</span>
      </div>
      <div className="stats-grid">
        {columns.map((c) => <StatCard key={c.name} col={c} p={res[c.name]} busy={current === c.name} />)}
      </div>
    </div>
  )
}

function StatCard({ col, p, busy }: { col: Column; p: ColumnProfile | string | undefined; busy: boolean }): ReactNode {
  const head = <header><b className="ellipsis">{col.name}</b><span className="faint mono ellipsis">{col.type}</span></header>
  if (typeof p === 'string') return <section className="stat-card" aria-label={`Column ${col.name}`}>{head}<div className="danger-text selectable">{p}</div></section>
  if (!p) return <section className="stat-card" aria-label={`Column ${col.name}`}>{head}<div className="muted">{busy ? 'Profiling…' : 'Waiting…'}</div></section>
  const nonNull = p.total - p.nulls
  const unique = nonNull > 0 && p.distinct === nonNull
  // every value of a unique column appears once, so its "most common" list says nothing
  const bars = p.hist.length ? p.hist.map((b) => ({ label: `${short(b.from)} – ${short(b.to)}`, n: b.n })) : unique ? [] : p.top.map((t) => ({ label: t.v === null ? 'NULL' : t.v === '' ? '(empty)' : t.v, n: t.n }))
  const most = Math.max(1, ...bars.map((b) => b.n))
  const stat = (k: string, v: ReactNode): ReactNode => <><dt>{k}</dt><dd className="selectable">{v}</dd></>
  return (
    <section className="stat-card" aria-label={`Column ${col.name}`}>
      {head}
      <dl>
        {stat('Rows', p.total.toLocaleString())}
        {stat('Nulls', `${p.nulls.toLocaleString()} · ${pct(p.nulls, p.total)}`)}
        {stat('Distinct', <>{p.distinct.toLocaleString()} · {pct(p.distinct, nonNull)}{unique && <span className="badge-soft">unique</span>}</>)}
        {p.min !== null && stat('Min', <span className="mono ellipsis" title={p.min}>{p.min}</span>)}
        {p.max !== null && stat('Max', <span className="mono ellipsis" title={p.max}>{p.max}</span>)}
        {p.avg !== null && stat('Average', <span className="mono">{short(p.avg)}</span>)}
        {p.minLen !== null && stat('Length', <span className="mono">{p.minLen} – {p.maxLen}</span>)}
      </dl>
      {bars.length > 0 && (
        <div className="stat-bars" role="list" aria-label={p.hist.length ? 'Histogram' : 'Most common values'}>
          <div className="faint" style={{ fontSize: 'var(--fs-xs)' }}>{p.hist.length ? 'Distribution' : 'Most common'}</div>
          {bars.map((b, i) => (
            <div key={i} role="listitem" className="stat-bar" title={`${b.label}: ${b.n.toLocaleString()}`}>
              <span className="mono ellipsis">{b.label}</span>
              <span className="track"><span style={{ width: `${(b.n / most) * 100}%` }} /></span>
              <span className="mono faint">{b.n.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
