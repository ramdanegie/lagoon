// Visual explain: plan tree of node cards, per-type / per-table stats and the raw plan, inside a result tab.
import { type ReactNode, useMemo, useState } from 'react'
import { type Plan, type PlanNode, type PlanStat, planStats, planText, fmtNum } from '@shared/explain'
import { call, fail, toast, useSetting } from '../lib/api'
import { Icon } from '../components/Icon'
import { menuBelow } from '../components/ui'
import '../styles/explain.css'

const unit = (p: Plan): string => (p.metric === 'time' ? 'Time (ms)' : 'Cost')

export function ExplainView({ plan, title, pinned, onPin }: { plan: Plan; title: string; pinned?: boolean; onPin: () => void }): ReactNode {
  const [mode, setMode] = useState<'plan' | 'stats' | 'raw'>('plan')
  const [threshold, setThreshold] = useSetting('explain.threshold', 30)
  const [sel, setSel] = useState<PlanNode | null>(null)
  const stats = useMemo(() => planStats(plan), [plan])

  const exportText = async (): Promise<void> => {
    try {
      const p = await call<string | undefined>('dialog.save', { defaultPath: `${title.replace(/[^\w-]+/g, '_')}.txt`, filters: [{ name: 'Text', extensions: ['txt'] }] })
      if (p) { await call('file.write', p, planText(plan)); toast('Plan saved') }
    } catch (e) { fail(e) }
  }

  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <div className="row plan-bar">
        <div className="seg" role="tablist" aria-label="Plan view">
          {(['plan', 'stats', 'raw'] as const).map((m) => <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>{m === 'plan' ? 'Plan' : m === 'stats' ? 'Stats' : 'Raw'}</button>)}
        </div>
        <span className="muted ellipsis">
          {plan.format}
          {plan.metric !== 'none' && ` · total ${plan.metric} ${fmtNum(plan.total)}${plan.metric === 'time' ? ' ms' : ''}`}
          {plan.planningTime !== undefined && ` · planning ${fmtNum(plan.planningTime)} ms`}
          {plan.executionTime !== undefined && ` · execution ${fmtNum(plan.executionTime)} ms`}
        </span>
        <span className="grow" />
        {plan.metric !== 'none' && (
          <label className="row plan-threshold" title={`Highlight nodes whose own ${plan.metric} is at least this share of the total`}>
            Highlight ≥
            <input type="range" min={0} max={100} step={5} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} aria-label="Highlight threshold, percent" />
            <span className="mono">{threshold}%</span>
          </label>
        )}
        <button className="btn ghost sm" onClick={(e) => menuBelow(e.currentTarget, [
          { label: 'Copy Plan as Text', onClick: () => { void navigator.clipboard.writeText(planText(plan)); toast('Plan copied') } },
          { label: 'Save Plan as Text…', onClick: () => void exportText() },
          { label: 'Copy Raw Plan', onClick: () => void navigator.clipboard.writeText(plan.raw) }
        ])}>Export <Icon name="chevronDown" size={10} /></button>
        <button className={`btn ghost icon sm ${pinned ? 'on' : ''}`} aria-label="Pin result" title="Keep this result when re-running" onClick={onPin}><Icon name="pin" size={12} /></button>
      </div>
      {mode === 'plan' && (
        <div className="row grow plan-split">
          <div className="plan-canvas">
            <ul className="plan-tree"><PlanItem n={plan.root} plan={plan} threshold={threshold} sel={sel} onSel={setSel} /></ul>
          </div>
          {sel && <NodeDetail n={sel} plan={plan} onClose={() => setSel(null)} />}
        </div>
      )}
      {mode === 'stats' && (
        <div className="plan-stats">
          <StatTable title="Per node type" head="Node type" rows={stats.byType} plan={plan} />
          <StatTable title="Per table" head="Table" rows={stats.byRelation} plan={plan} />
        </div>
      )}
      {mode === 'raw' && <div className="message-view">{plan.raw}</div>}
    </div>
  )
}

function PlanItem({ n, plan, threshold, sel, onSel }: { n: PlanNode; plan: Plan; threshold: number; sel: PlanNode | null; onSel: (n: PlanNode) => void }): ReactNode {
  const hot = plan.metric !== 'none' && n.pctOfTotal >= threshold
  const where = [n.relation && !n.op.includes(n.relation) ? n.relation : '', n.index && !n.op.includes(n.index) ? `using ${n.index}` : ''].filter(Boolean).join(' ')
  return (
    <li>
      <button className={`plan-node ${hot ? 'hot' : ''} ${sel === n ? 'sel' : ''}`} aria-pressed={sel === n} onClick={() => onSel(n)} title={n.filter}>
        <span className="pn-op">{n.op}</span>
        {where && <span className="pn-rel mono">{where}</span>}
        <span className="pn-meta">
          {n.rows !== undefined && <span>{fmtNum(n.rows)} rows</span>}
          {n.actualRows !== undefined && <span>{fmtNum(n.actualRows)} actual</span>}
          {plan.metric === 'time' ? <span>{fmtNum(n.actualTime)} ms</span> : n.cost !== undefined && <span>cost {fmtNum(n.cost)}</span>}
        </span>
        {plan.metric !== 'none' && (
          <span className="pn-share">
            <span className="pn-bar"><span style={{ width: `${Math.min(100, n.pctOfTotal)}%` }} /></span>
            <span className="pn-pct">{n.pctOfTotal.toFixed(1)}%</span>
          </span>
        )}
      </button>
      {n.children.length > 0 && <ul>{n.children.map((c, i) => <PlanItem key={i} n={c} plan={plan} threshold={threshold} sel={sel} onSel={onSel} />)}</ul>}
    </li>
  )
}

const show = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))

function NodeDetail({ n, plan, onClose }: { n: PlanNode; plan: Plan; onClose: () => void }): ReactNode {
  const main: [string, unknown][] = [
    ['Operation', n.op], ['Table', n.relation], ['Index', n.index], ['Condition', n.filter],
    ['Estimated rows', fmtNum(n.rows)], ['Actual rows', fmtNum(n.actualRows)], ['Cost', fmtNum(n.cost)],
    ['Actual time', n.actualTime === undefined ? '' : `${fmtNum(n.actualTime)} ms`], ['Loops', n.loops],
    ...(plan.metric === 'none' ? [] : [[`Own ${plan.metric}`, fmtNum(n.self)], ['Share of total', `${n.pctOfTotal.toFixed(1)}%`]] as [string, unknown][])
  ]
  return (
    <aside className="plan-detail" aria-label="Node properties">
      <div className="row"><b className="grow ellipsis">{n.op}</b><button className="btn ghost icon sm" aria-label="Close properties" onClick={onClose}><Icon name="x" size={10} /></button></div>
      <div className="kv selectable">{main.filter(([, v]) => show(v) !== '').map(([k, v]) => [<span key={`k${k}`}>{k}</span>, <span key={`v${k}`} className="mono">{show(v)}</span>])}</div>
      <div className="section-title">All properties</div>
      <div className="kv selectable">{Object.entries(n.props).map(([k, v]) => [<span key={`k${k}`}>{k}</span>, <span key={`v${k}`} className="mono">{show(v)}</span>])}</div>
    </aside>
  )
}

function StatTable({ title, head, rows, plan }: { title: string; head: string; rows: PlanStat[]; plan: Plan }): ReactNode {
  return (
    <section>
      <div className="section-title">{title}</div>
      {rows.length === 0 ? <div className="faint plan-none">No entries</div> : (
        <table className="plan-table">
          <thead><tr><th>{head}</th><th>Nodes</th>{plan.metric !== 'none' && <><th>Own {unit(plan).toLowerCase()}</th><th>% of total</th></>}<th>Rows</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="mono">{r.key}</td><td>{r.count}</td>
                {plan.metric !== 'none' && <><td>{fmtNum(r.self)}</td><td>{r.pct.toFixed(1)}%</td></>}
                <td>{fmtNum(r.rows)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
