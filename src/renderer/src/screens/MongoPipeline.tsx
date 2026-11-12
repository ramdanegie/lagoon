// Aggregation pipeline builder for one collection: stages in order, each can be switched off, and the output of the
// selected stage is previewed on the real data as you type.
import { type ReactNode, useEffect, useState } from 'react'
import { call, errText, toast } from '../lib/api'
import { useWs } from '../lib/ws'
import type { Doc } from '../lib/nosql'
import { Icon } from '../components/Icon'
import { CodeEditor, DocsGrid } from './MongoQuery'

const TEMPLATES: Record<string, string> = {
  $match: '{ status: "active" }',
  $project: '{ _id: 0, name: 1 }',
  $group: '{ _id: "$field", count: { $sum: 1 } }',
  $sort: '{ count: -1 }',
  $limit: '10',
  $skip: '0',
  $unwind: '"$items"',
  $lookup: '{ from: "other", localField: "otherId", foreignField: "_id", as: "other" }',
  $addFields: '{ total: { $add: ["$a", "$b"] } }',
  $set: '{ field: "value" }',
  $unset: '"field"',
  $count: '"count"',
  $sortByCount: '"$field"',
  $sample: '{ size: 10 }',
  $replaceRoot: '{ newRoot: "$field" }',
  $bucket: '{ groupBy: "$field", boundaries: [0, 10, 100], default: "other" }',
  $facet: '{ byField: [{ $sortByCount: "$field" }] }'
}
const PREVIEW = 100

interface Stage { op: string; body: string; on: boolean }
const pipelineText = (stages: Stage[]): string => `[\n${stages.filter((s) => s.on).map((s) => `  { ${s.op}: ${s.body.trim() || '{}'} }`).join(',\n')}\n]`

export function MongoPipeline({ coll, visible }: { coll: string; visible: boolean }): ReactNode {
  const sessionId = useWs((s) => s.sessionId)
  const [stages, setStages] = useState<Stage[]>([{ op: '$match', body: '{}', on: true }])
  const [sel, setSel] = useState(0)
  const [docs, setDocs] = useState<Doc[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const upTo = pipelineText(stages.slice(0, sel + 1))
  useEffect(() => {
    if (!visible || !sessionId) return
    let live = true
    const t = setTimeout(() => {
      setBusy(true)
      call<string[]>('mongo.aggregate', sessionId, coll, upTo, PREVIEW)
        .then((r) => { if (live) { setDocs(r.map((d) => JSON.parse(d) as Doc)); setError('') } }, (e) => { if (live) setError(errText(e)) })
        .finally(() => live && setBusy(false))
    }, 400)
    return () => { live = false; clearTimeout(t) }
  }, [upTo, visible, sessionId, coll])

  const patch = (i: number, p: Partial<Stage>): void => setStages((s) => s.map((x, k) => (k === i ? { ...x, ...p } : x)))
  const move = (i: number, d: -1 | 1): void => {
    const j = i + d
    if (j < 0 || j >= stages.length) return
    setStages((s) => { const n = [...s]; [n[i], n[j]] = [n[j], n[i]]; return n })
    setSel(j)
  }
  const remove = (i: number): void => { setStages((s) => s.filter((_x, k) => k !== i)); setSel((v) => Math.max(0, v >= i ? v - 1 : v)) }
  const add = (): void => { setStages((s) => [...s, { op: '$project', body: TEMPLATES.$project, on: true }]); setSel(stages.length) }
  const cur = stages[sel]

  return (
    <div className="nosql-row" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="nosql-pane" style={{ width: 440, flex: 'none', borderRight: '1px solid var(--border)' }}>
        <div className="nosql-head">
          <b className="grow">Pipeline · {stages.filter((s) => s.on).length} stage{stages.filter((s) => s.on).length === 1 ? '' : 's'}</b>
          <button className="btn sm" title="Copy as a shell command for a query tab" onClick={() => { void navigator.clipboard.writeText(`db.getCollection(${JSON.stringify(coll)}).aggregate(${pipelineText(stages)})`); toast('Pipeline copied') }}>Copy</button>
        </div>
        <div className="col" style={{ overflow: 'auto', flex: 1 }} role="list" aria-label="Stages">
          {stages.map((s, i) => (
            <div key={i} role="listitem" aria-label={`Stage ${i + 1}`} className={`pipe-stage ${sel === i ? 'on' : ''} ${s.on ? '' : 'off'}`} onMouseDown={() => setSel(i)}>
              <div className="row" style={{ gap: 'var(--sp-2)' }}>
                <input type="checkbox" checked={s.on} aria-label={`Run stage ${i + 1}`} onChange={(e) => patch(i, { on: e.target.checked })} />
                <span className="faint mono">{i + 1}</span>
                <select className="select" aria-label={`Stage ${i + 1} operator`} value={s.op} onChange={(e) => patch(i, { op: e.target.value, body: s.body === TEMPLATES[s.op] || !s.body.trim() || s.body.trim() === '{}' ? TEMPLATES[e.target.value] : s.body })}>
                  {Object.keys(TEMPLATES).map((op) => <option key={op} value={op}>{op}</option>)}
                </select>
                <span className="grow" />
                <button className="btn ghost icon sm" aria-label={`Move stage ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}><span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}><Icon name="chevronDown" size={11} /></span></button>
                <button className="btn ghost icon sm" aria-label={`Move stage ${i + 1} down`} disabled={i === stages.length - 1} onClick={() => move(i, 1)}><Icon name="chevronDown" size={11} /></button>
                <button className="btn ghost icon sm" aria-label={`Remove stage ${i + 1}`} disabled={stages.length === 1} onClick={() => remove(i)}><Icon name="x" size={11} /></button>
              </div>
              <CodeEditor value={s.body} onChange={(v) => patch(i, { body: v })} lang="js" label={`Stage ${i + 1} body`} style={{ maxHeight: 180 }} />
            </div>
          ))}
          <div style={{ padding: 'var(--sp-3) var(--sp-4)' }}><button className="btn sm" onClick={add}><Icon name="plus" size={11} /> Add stage</button></div>
        </div>
      </div>
      <div className="nosql-pane grow">
        <div className="nosql-head">
          <span className="grow">Output after stage {sel + 1}{cur ? <span className="mono"> {cur.op}</span> : null}{cur && !cur.on ? ' (switched off)' : ''}</span>
          {busy && <span className="muted">Running…</span>}
          {!busy && docs && !error && <span className="muted">{docs.length < PREVIEW ? `${docs.length} document${docs.length === 1 ? '' : 's'}` : `first ${PREVIEW} documents`}</span>}
        </div>
        {error ? <div className="nosql-error" role="alert">{error}</div> : <DocsGrid docs={docs ?? []} />}
      </div>
    </div>
  )
}
