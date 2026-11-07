// Test data generator: pick tables and row counts, tune per-column generators, preview, then insert (background job) or copy SQL.
import { type ReactNode, useEffect, useState } from 'react'
import type { Column, DbObject, ForeignKey } from '@shared/types'
import { GENERATORS, autoGen, fkOrder, planSummary, type ColGen, type GenKind, type GenPlan, type TableGen } from '@shared/datagen'
import { call, errText, fail, toast } from '../lib/api'
import { useWs, guard } from '../lib/ws'
import { Modal, confirmDialog } from '../components/ui'
import { Grid } from '../components/Grid'
import { JobStatus, useJobs } from './ImportExport'
import '../styles/datagen.css'

interface Info { columns: Column[]; fks: ForeignKey[]; unique: string[]; enums: Record<string, string[]> }
type Preview = { columns: string[]; rows: unknown[][] }

const newSeed = (): number => Math.floor(Math.random() * 1e9)
const KIND_DEFAULTS: Partial<Record<GenKind, Partial<ColGen>>> = {
  int: { min: '1', max: '1000' }, decimal: { min: '0', max: '1000', scale: 2 }, date: { min: '2020-01-01', max: '2025-12-31' },
  datetime: { min: '2020-01-01', max: '2025-12-31' }, pattern: { text: '[A-Z]{3}-\\d{4}' }, list: { values: [] }, enum: { values: [] }, constant: { text: '' }
}

export function DataGenerator({ table, onClose }: { table?: DbObject; onClose: () => void }): ReactNode {
  const sessionId = useWs((s) => s.sessionId)
  const dialect = useWs((s) => s.dialect) ?? 'postgres'
  const curSchema = useWs((s) => s.schema)
  const objects = useWs((s) => s.objects)
  const schema = table?.schema ?? curSchema ?? ''
  const tables = objects.filter((o) => o.kind === 'table' && o.schema === schema)
  const [infos, setInfos] = useState<Record<string, Info>>({})
  const [specs, setSpecs] = useState<Record<string, TableGen>>({})
  const [on, setOn] = useState<string[]>(table ? [table.name] : [])
  const [active, setActive] = useState(table?.name ?? '')
  const [seed, setSeed] = useState(newSeed)
  const [keepSeed, setKeepSeed] = useState(false)
  const [deleteFirst, setDeleteFirst] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewErr, setPreviewErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [jobId, setJobId] = useState<string>()
  const job = useJobs((s) => s.list.find((j) => j.id === jobId))
  const spec = specs[active]
  const info = infos[active]

  const load = (name: string): Promise<TableGen> => call<Info>('gen.inspect', sessionId, schema, name).then((i) => {
    const t: TableGen = {
      table: name, rows: 100,
      columns: i.columns.map((c) => {
        const f = i.fks.find((x) => x.columns.includes(c.name))
        const ref = f && { schema: f.refSchema || schema, table: f.refTable, column: f.refColumns[f.columns.indexOf(c.name)] }
        return autoGen(dialect, c, { ref, values: i.enums[c.name], unique: i.unique.includes(c.name), self: !!ref && ref.schema === schema && ref.table === name })
      })
    }
    setInfos((s) => ({ ...s, [name]: i }))
    setSpecs((s) => (s[name] ? s : { ...s, [name]: t }))
    return t
  })

  useEffect(() => { if (active && !specs[active] && sessionId) load(active).catch(fail) }, [active, sessionId])
  useEffect(() => {
    if (!spec || !sessionId) return
    const t = setTimeout(() => {
      call<Preview>('gen.preview', sessionId, schema, spec, seed).then((p) => { setPreview(p); setPreviewErr('') }, (e) => { setPreview(null); setPreviewErr(errText(e)) })
    }, 300)
    return () => clearTimeout(t)
  }, [spec, seed, sessionId])
  useEffect(() => { if (job?.state === 'done') window.dispatchEvent(new CustomEvent('ws:reload')) }, [job?.state])

  const toggle = (name: string, checked: boolean): void => {
    setOn((o) => (checked ? [...o.filter((x) => x !== name), name] : o.filter((x) => x !== name)))
    if (checked) setActive(name)
  }
  const patchTable = (name: string, p: Partial<TableGen>): void => setSpecs((s) => ({ ...s, [name]: { ...s[name], ...p } }))
  const setCol = (i: number, p: Partial<ColGen>): void => patchTable(active, { columns: spec.columns.map((c, k) => (k === i ? { ...c, ...p } : c)) })
  const setKind = (i: number, kind: GenKind): void => {
    const c = spec.columns[i]
    const defaults = Object.fromEntries(Object.entries(KIND_DEFAULTS[kind] ?? {}).filter(([k]) => c[k as keyof ColGen] === undefined || (k === 'values' && !c.values?.length)))
    if (kind === 'enum' && info?.enums[c.column]) defaults.values = info.enums[c.column]
    setCol(i, { kind, ...defaults })
  }

  const plan = async (): Promise<GenPlan> => ({ schema, seed, deleteFirst, tables: await Promise.all(on.map((n) => specs[n] ?? load(n))) })
  const live = on.filter((n) => (specs[n]?.rows ?? 100) > 0)

  const run = async (): Promise<void> => {
    if (!sessionId) return
    setBusy(true)
    try {
      const p = await plan()
      if (deleteFirst && !(await confirmDialog('Delete existing rows first?', `All rows in ${on.join(', ')} are deleted before the new rows are inserted. Deletes and inserts run in one transaction, so a failure keeps the old rows.`, { ok: 'Delete and generate', danger: true }))) return
      if (!(await guard(planSummary(dialect, p)))) return
      setJobId(await call<string>('gen.run', sessionId, p))
      if (!keepSeed) setSeed(newSeed())
    } catch (e) { fail(e) } finally { setBusy(false) }
  }
  const copySql = async (): Promise<void> => {
    setBusy(true)
    try {
      const p = await plan()
      await navigator.clipboard.writeText(await call<string>('gen.sql', sessionId, p))
      toast(`Copied INSERT statements for ${p.tables.length} table${p.tables.length === 1 ? '' : 's'}`, 'success')
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  const order = on.length > 1 && on.every((n) => specs[n]) ? fkOrder(on.map((n) => specs[n]), schema).map((t) => t.table) : []
  const nullable = (name: string): boolean => info?.columns.find((c) => c.name === name)?.nullable ?? true

  const options = (c: ColGen, i: number): ReactNode => {
    const box = (k: 'min' | 'max' | 'text', label: string, type = 'text'): ReactNode => (
      <input className="input sm" type={type} aria-label={`${label} for ${c.column}`} placeholder={label} value={c[k] ?? ''} onChange={(e) => setCol(i, { [k]: e.target.value })} />
    )
    switch (c.kind) {
      case 'int': case 'decimal': return <>{box('min', 'From', 'number')}{box('max', 'To', 'number')}</>
      case 'date': case 'datetime': return <>{box('min', 'From', 'date')}{box('max', 'To', 'date')}</>
      case 'pattern': return box('text', 'Pattern, e.g. [A-Z]{3}-\\d{4}')
      case 'constant': return box('text', 'Value')
      case 'enum': case 'list':
        return <input className="input sm grow" aria-label={`Values for ${c.column}`} placeholder="Comma-separated values" value={(c.values ?? []).join(',')} onChange={(e) => setCol(i, { values: e.target.value.split(',') })} />
      case 'fk': return <span className="mono faint ellipsis">→ {c.ref ? `${c.ref.table}.${c.ref.column}` : '?'}</span>
      default: return null
    }
  }

  return (
    <Modal
      title="Generate test data"
      onClose={onClose}
      width={1080}
      footer={
        <>
          <label className="check">Seed <input className="input sm gen-seed" type="number" aria-label="Seed" value={seed} onChange={(e) => setSeed(Number(e.target.value) || 0)} /></label>
          <label className="check" title="Keep this seed after generating, so the same settings give the same rows again"><input type="checkbox" checked={keepSeed} onChange={(e) => setKeepSeed(e.target.checked)} /> Keep seed</label>
          <label className="check"><input type="checkbox" checked={deleteFirst} onChange={(e) => setDeleteFirst(e.target.checked)} /> Delete existing rows first</label>
          <div className="grow">{job && <JobStatus job={job} />}</div>
          {job?.state === 'running' ? (
            <>
              <button className="btn" onClick={() => void call('job.cancel', job.id)}>Stop</button>
              <button className="btn" onClick={onClose}>Run in background</button>
            </>
          ) : (
            <>
              <button className="btn" onClick={onClose}>Close</button>
              <button className="btn" disabled={!live.length || busy} title="Foreign keys to parent rows that the database numbers itself can only use rows that exist now" onClick={() => void copySql()}>Copy as SQL</button>
              <button className="btn primary" disabled={!live.length || busy} onClick={() => void run()}>Generate</button>
            </>
          )}
        </>
      }
    >
      <div className="gen">
        <div className="col gen-side">
          <div className="section-title" style={{ padding: 0 }}>Tables in {schema || 'this schema'}</div>
          <div className="gen-tables" role="group" aria-label="Tables to fill">
            {tables.map((t) => (
              <div key={t.name} className={`list-item gen-table ${active === t.name ? 'selected' : ''}`}>
                <input type="checkbox" aria-label={`Generate rows for ${t.name}`} checked={on.includes(t.name)} onChange={(e) => toggle(t.name, e.target.checked)} />
                <button className="gen-name ellipsis" onClick={() => setActive(t.name)}>{t.name}</button>
                {on.includes(t.name) && (
                  <input className="input sm gen-rows" type="number" min={0} aria-label={`Rows for ${t.name}`} value={specs[t.name]?.rows ?? 100} disabled={!specs[t.name]}
                    onChange={(e) => patchTable(t.name, { rows: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                )}
              </div>
            ))}
            {!tables.length && <div className="empty">No tables in this schema.</div>}
          </div>
          {order.length > 0 && <div className="faint gen-order" title="Parents are filled before the tables that reference them">Order: {order.join(' → ')}</div>}
        </div>
        <div className="col gen-main">
          {!active && <div className="empty">Tick a table on the left to set up its columns.</div>}
          {active && !spec && <div className="empty">Loading {active}…</div>}
          {spec && (
            <>
              <div className="gen-scroll">
                <table className="ie-map gen-cols">
                  <thead><tr><th scope="col">Column</th><th scope="col">Generator</th><th scope="col">Options</th><th scope="col">Null %</th><th scope="col">Unique</th></tr></thead>
                  <tbody>
                    {spec.columns.map((c, i) => (
                      <tr key={c.column} className={c.kind === 'skip' ? 'gen-skip' : ''}>
                        <td><div className="mono ellipsis" title={c.column}>{c.column}</div><div className="faint ellipsis gen-type" title={c.type}>{c.type}</div></td>
                        <td>
                          <select className="select sm" aria-label={`Generator for ${c.column}`} value={c.kind} onChange={(e) => setKind(i, e.target.value as GenKind)}>
                            {GENERATORS.filter(([k]) => k !== 'fk' || c.ref).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                          </select>
                        </td>
                        <td><div className="gen-opts">{options(c, i)}</div></td>
                        <td><input className="input sm gen-pct" type="number" min={0} max={100} aria-label={`Null percentage for ${c.column}`} disabled={c.kind === 'skip' || !nullable(c.column)} value={c.nullPct} onChange={(e) => setCol(i, { nullPct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} /></td>
                        <td><input type="checkbox" aria-label={`Unique values for ${c.column}`} disabled={c.kind === 'skip'} checked={c.unique} onChange={(e) => setCol(i, { unique: e.target.checked })} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row">
                <span className="section-title" style={{ padding: 0 }}>Preview · first {Math.min(20, spec.rows)} rows of {active}</span>
                <span className="grow" />
                <button className="btn sm" onClick={() => setSeed(newSeed())}>Shuffle</button>
              </div>
              {previewErr && <div className="danger-text selectable">{previewErr}</div>}
              <div className="gen-preview">
                <Grid columns={(preview?.columns ?? []).map((name) => ({ name, type: spec.columns.find((c) => c.column === name)?.type }))} rows={preview?.rows ?? []} empty={<div className="empty">{spec.columns.every((c) => c.kind === 'skip') ? 'Every column uses its default value.' : 'No rows'}</div>} />
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
