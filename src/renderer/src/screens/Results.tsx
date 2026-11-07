import { type ReactNode, Suspense, lazy, useMemo, useState } from 'react'
import type { Result } from '@shared/types'
import type { Plan } from '@shared/explain'
import { chartDirective } from '@shared/split'
import { useWs } from '../lib/ws'
import { COPY_FORMATS, formatRows, display } from '../lib/format'
import { addToMetricsBoard } from '../lib/metrics'
import { Grid, type Sel } from '../components/Grid'
const Chart = lazy(() => import('../components/Chart').then((m) => ({ default: m.Chart })))
import { Icon } from '../components/Icon'
import { menuAt } from '../components/ui'
import { QuickLook } from './QuickLook'
import { ExportResultDialog } from './ImportExport'
import { ExplainView } from './Explain'

/** `plan`: an explain result shown as a plan; `summary`: one row per statement of the run. */
export interface ResultTab { id: string; title: string; results: Result[]; pinned?: boolean; plan?: Plan; summary?: boolean }

const SEARCH_OPS = ['Contains', 'Not contains', 'Has prefix', 'Has suffix'] as const

export function ResultsPane({ tabs, active, onActive, onPin, onClose, running }: { tabs: ResultTab[]; active: number; onActive: (i: number) => void; onPin: (id: string) => void; onClose: (id: string) => void; running: boolean }): ReactNode {
  const tab = tabs[active] ?? tabs[0]
  const [jump, setJump] = useState<{ id: string; idx: number } | null>(null)
  if (!tabs.length) {
    return <div className="empty" style={{ flex: 1 }}>{running ? 'Running…' : 'Run a query to see results here. ⌘↩ runs the statement under the cursor, ⇧⌘↩ runs everything.'}</div>
  }
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      {tabs.length > 1 && (
        <div className="result-tabs" role="tablist" aria-label="Result tabs">
          {tabs.map((t, i) => {
            const err = t.results.some((r) => r.error)
            return (
              <div key={t.id} role="tab" aria-selected={i === active} className={`result-tab ${i === active ? 'on' : ''} ${err ? 'err' : ''}`} onClick={() => onActive(i)} onContextMenu={(e) => menuAt(e, [{ label: t.pinned ? 'Unpin' : 'Pin', onClick: () => onPin(t.id) }, { label: 'Close', onClick: () => onClose(t.id) }])}>
                {t.pinned && <Icon name="pin" size={10} />}
                {t.title}
              </div>
            )
          })}
        </div>
      )}
      {tab?.summary ? (
        <SummaryView tab={tab} onPin={() => onPin(tab.id)} onOpen={(res) => {
          const i = tabs.findIndex((t) => !t.summary && t.results.includes(res))
          if (i < 0) return
          setJump({ id: tabs[i].id, idx: tabs[i].results.indexOf(res) })
          onActive(i)
        }} />
      ) : tab?.plan ? (
        <ExplainView key={tab.id} plan={tab.plan} title={tab.title} pinned={tab.pinned} onPin={() => onPin(tab.id)} />
      ) : tab && <ResultView key={`${tab.id}:${jump?.id === tab.id ? jump.idx : 0}`} tab={tab} initialIdx={jump?.id === tab.id ? jump.idx : 0} onPin={() => onPin(tab.id)} running={running} />}
    </div>
  )
}

function ResultView({ tab, initialIdx, onPin, running }: { tab: ResultTab; initialIdx: number; onPin: () => void; running: boolean }): ReactNode {
  const [idx, setIdx] = useState(initialIdx)
  const res = tab.results[Math.min(idx, tab.results.length - 1)]
  const hasRows = res.columns.length > 0
  const directive = chartDirective(res.sql)
  const [mode, setMode] = useState<'data' | 'message' | 'chart'>(res.error ? 'message' : directive ? 'chart' : hasRows ? 'data' : 'message')
  const [search, setSearch] = useState<{ col: string; op: (typeof SEARCH_OPS)[number]; text: string; caseSensitive: boolean } | null>(null)
  const [sel, setSel] = useState<Sel | null>(null)
  const [quick, setQuick] = useState<{ r: number; c: number } | null>(null)
  const [exporting, setExporting] = useState(false)
  const [chart, setChart] = useState<{ type: 'bar' | 'line' | 'pie'; x?: string; y: string[] }>(() => directive ?? { type: 'bar', x: res.columns[0]?.name, y: res.columns.slice(1, 2).map((c) => c.name) })
  const conn = useWs((s) => s.conn)
  const cols = res.columns.map((c) => c.name)

  const rows = useMemo(() => {
    if (!search?.text) return res.rows
    const needle = search.caseSensitive ? search.text : search.text.toLowerCase()
    const ci = search.col === '__any__' ? -1 : cols.indexOf(search.col)
    const test = (v: unknown): boolean => {
      const s = search.caseSensitive ? display(v) : display(v).toLowerCase()
      return search.op === 'Contains' ? s.includes(needle) : search.op === 'Not contains' ? !s.includes(needle) : search.op === 'Has prefix' ? s.startsWith(needle) : s.endsWith(needle)
    }
    return res.rows.filter((r) => (ci < 0 ? (search.op === 'Not contains' ? r.every(test) : r.some(test)) : test(r[ci])))
  }, [res, search])

  const selected = (): unknown[][] => (sel ? rows.slice(sel.r0, sel.r1 + 1) : [])
  const copy = (fmt: Parameters<typeof formatRows>[0], cells = false): void => {
    if (!sel) return
    const data = selected().map((r) => (cells ? r.slice(sel.c0, sel.c1 + 1) : r))
    void navigator.clipboard.writeText(formatRows(fmt, cells ? cols.slice(sel.c0, sel.c1 + 1) : cols, data, { dialect: 'postgres', schema: '', table: 'query_result' }))
  }

  const message = [
    res.error ? `Error: ${res.error}` : res.columns.length ? `${res.rowCount.toLocaleString()} row(s) returned` : `${res.affected ?? 0} row(s) affected`,
    res.command ? `Command: ${res.command}` : '',
    `Time: ${res.ms} ms`,
    ...(res.notices ?? []),
    '',
    res.sql
  ].filter((x, i) => x || i > 3).join('\n')

  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <div className="row" style={{ height: 28, padding: '0 var(--sp-4)', borderBottom: '1px solid var(--border)', fontSize: 'var(--fs-sm)', flex: 'none' }}>
        <div className="seg" role="tablist" aria-label="Result view">
          <button role="tab" aria-selected={mode === 'data'} className={mode === 'data' ? 'on' : ''} disabled={!hasRows} onClick={() => setMode('data')}>Data</button>
          <button role="tab" aria-selected={mode === 'message'} className={mode === 'message' ? 'on' : ''} onClick={() => setMode('message')}>Message</button>
          <button role="tab" aria-selected={mode === 'chart'} className={mode === 'chart' ? 'on' : ''} disabled={!hasRows} onClick={() => setMode('chart')}>Chart</button>
        </div>
        {tab.results.length > 1 && (
          <select className="select sm" aria-label="Statement" value={idx} onChange={(e) => setIdx(Number(e.target.value))}>
            {tab.results.map((r, i) => <option key={i} value={i}>{i + 1}. {r.sql.replace(/\s+/g, ' ').slice(0, 50)}</option>)}
          </select>
        )}
        <span className={res.error ? 'danger-text ellipsis' : 'muted'} title={res.error}>
          {res.error ? res.error.split('\n')[0] : hasRows ? `${rows.length.toLocaleString()}${search?.text ? ` of ${res.rowCount.toLocaleString()}` : ''} rows` : `${res.affected ?? 0} affected`} · {res.ms} ms
        </span>
        <span className="grow" />
        {running && <span className="faint">Running…</span>}
        {hasRows && mode === 'data' && <button className={`btn ghost icon sm ${search ? 'on' : ''}`} aria-label="Search in result" title="Search loaded rows" onClick={() => setSearch(search ? null : { col: '__any__', op: 'Contains', text: '', caseSensitive: false })}><Icon name="search" size={12} /></button>}
        {hasRows && <button className="btn ghost sm" onClick={() => setExporting(true)}>Export…</button>}
        <button className={`btn ghost icon sm ${tab.pinned ? 'on' : ''}`} aria-label="Pin result" title="Keep this result when re-running" onClick={onPin}><Icon name="pin" size={12} /></button>
      </div>
      {search && mode === 'data' && (
        <div className="row" style={{ padding: 'var(--sp-3) var(--sp-4)', borderBottom: '1px solid var(--border)' }}>
          <select className="select sm" aria-label="Search column" value={search.col} onChange={(e) => setSearch({ ...search, col: e.target.value })}><option value="__any__">Any column</option>{cols.map((c) => <option key={c}>{c}</option>)}</select>
          <select className="select sm" aria-label="Search operator" value={search.op} onChange={(e) => setSearch({ ...search, op: e.target.value as typeof search.op })}>{SEARCH_OPS.map((o) => <option key={o}>{o}</option>)}</select>
          <input className="input sm grow" autoFocus placeholder="Search loaded rows" aria-label="Search text" value={search.text} onChange={(e) => setSearch({ ...search, text: e.target.value })} onKeyDown={(e) => e.key === 'Escape' && setSearch(null)} />
          <label className="check" style={{ fontSize: 'var(--fs-xs)' }}><input type="checkbox" checked={search.caseSensitive} onChange={(e) => setSearch({ ...search, caseSensitive: e.target.checked })} /> Match case</label>
        </div>
      )}
      {mode === 'data' && hasRows && (
        <Grid
          columns={res.columns.map((c) => ({ name: c.name, type: c.type }))}
          rows={rows}
          onSelect={setSel}
          onActivate={(r, c) => setQuick({ r, c })}
          onCopy={(e) => e.clipboardData?.setData('text/plain', formatRows('csv', cols, selected()))}
          onKey={(e, s) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && s) { setQuick({ r: s.r1, c: s.c1 }); return true } return false }}
          onCellMenu={(e, r, c) => menuAt(e, [
            { label: 'Quick Look', onClick: () => setQuick({ r, c }) },
            { label: 'Copy Rows', kbd: '⌘C', onClick: () => copy('csv') },
            { label: 'Copy Rows As', submenu: COPY_FORMATS.map((f) => ({ label: f.label, onClick: () => copy(f.id) })) },
            { label: 'Copy Selected Cells', onClick: () => copy('plain', true) },
            { label: 'Copy Selected Cells As', submenu: COPY_FORMATS.filter((f) => f.id !== 'insert').map((f) => ({ label: f.label, onClick: () => copy(f.id, true) })) },
            { label: 'Copy Column Values', onClick: () => void navigator.clipboard.writeText(rows.map((x) => display(x[c])).join('\n')) },
            { sep: true },
            { label: 'Export…', onClick: () => setExporting(true) }
          ])}
        />
      )}
      {mode === 'message' && <div className={`message-view ${res.error ? 'danger-text' : ''}`}>{message}</div>}
      {mode === 'chart' && hasRows && (
        <div className="col grow" style={{ minHeight: 0 }}>
          <div className="row" style={{ padding: 'var(--sp-3) var(--sp-4)', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
            <div className="seg">{(['bar', 'line', 'pie'] as const).map((t) => <button key={t} className={chart.type === t ? 'on' : ''} onClick={() => setChart({ ...chart, type: t })}>{t[0].toUpperCase() + t.slice(1)}</button>)}</div>
            <label className="row" style={{ fontSize: 'var(--fs-sm)' }}>{chart.type === 'pie' ? 'Label' : 'X axis'}<select className="select sm" value={chart.x} onChange={(e) => setChart({ ...chart, x: e.target.value })}>{cols.map((c) => <option key={c}>{c}</option>)}</select></label>
            <span style={{ fontSize: 'var(--fs-sm)' }}>{chart.type === 'pie' ? 'Value' : 'Y axis'}</span>
            {cols.filter((c) => c !== chart.x).map((c) => (
              <label key={c} className="check" style={{ fontSize: 'var(--fs-sm)' }}>
                <input type={chart.type === 'pie' ? 'radio' : 'checkbox'} name="chart-y" checked={chart.y.includes(c)} onChange={(e) => setChart({ ...chart, y: chart.type === 'pie' ? [c] : e.target.checked ? [...chart.y, c] : chart.y.filter((x) => x !== c) })} />{c}
              </label>
            ))}
            <span className="grow" />
            <button className="btn sm" onClick={() => void addToMetricsBoard({ type: chart.type, label: tab.title, query: res.sql, x: chart.x, y: chart.y })}><Icon name="chart" size={11} /> Add to Metrics Board</button>
          </div>
          <div className="grow" style={{ minHeight: 0, padding: 'var(--sp-5)' }}>
            <Suspense fallback={null}><Chart type={chart.type} columns={res.columns} rows={res.rows} x={chart.x} y={chart.y} /></Suspense>
          </div>
        </div>
      )}
      {quick && <QuickLook column={cols[quick.c]} value={rows[quick.r]?.[quick.c]} readOnly onSave={() => {}} onClose={() => setQuick(null)} />}
      {exporting && <ExportResultDialog title={tab.title} columns={cols} rows={rows} table={conn ? 'query_result' : undefined} onClose={() => setExporting(false)} />}
    </div>
  )
}

/** One row per statement of the last run; a row opens that statement's result. */
function SummaryView({ tab, onPin, onOpen }: { tab: ResultTab; onPin: () => void; onOpen: (r: Result) => void }): ReactNode {
  const failed = tab.results.filter((r) => r.error).length
  const total = tab.results.reduce((a, r) => a + r.ms, 0)
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <div className="row" style={{ height: 28, padding: '0 var(--sp-4)', borderBottom: '1px solid var(--border)', fontSize: 'var(--fs-sm)', flex: 'none' }}>
        <span className={failed ? 'danger-text' : 'muted'}>{tab.results.length} statements · {failed ? `${failed} failed` : 'all succeeded'} · {total} ms</span>
        <span className="grow" />
        <button className={`btn ghost icon sm ${tab.pinned ? 'on' : ''}`} aria-label="Pin result" title="Keep this result when re-running" onClick={onPin}><Icon name="pin" size={12} /></button>
      </div>
      <div className="summary-view">
        <table className="plan-table">
          <thead><tr><th>#</th><th>Status</th><th>Rows</th><th>Time</th><th>Statement</th></tr></thead>
          <tbody>
            {tab.results.map((r, i) => (
              <tr key={i} className="link" tabIndex={0} onClick={() => onOpen(r)} onKeyDown={(e) => e.key === 'Enter' && onOpen(r)} title={r.error ?? 'Open this result'}>
                <td className="faint">{i + 1}</td>
                <td className={r.error ? 'danger-text' : ''}>{r.error ? 'Error' : 'OK'}</td>
                <td>{r.error ? '' : r.columns.length ? `${r.rowCount.toLocaleString()} returned` : `${(r.affected ?? 0).toLocaleString()} affected`}</td>
                <td>{r.ms} ms</td>
                <td className="sql mono">{r.error ? <span className="danger-text">{r.error.split('\n')[0]} · </span> : null}{r.sql.split('\n').find((l) => l.trim() && !/^\s*--/.test(l))?.trim() ?? r.sql.trim()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
