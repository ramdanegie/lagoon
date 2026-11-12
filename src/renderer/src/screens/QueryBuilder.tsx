// Visual query builder: put tables on a canvas, tick columns, drag a column onto another table's column to join them
// (foreign keys join by themselves), add conditions and sorting, and take the SELECT it writes.
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import type { Column, DbObject, ForeignKey } from '@shared/types'
import { AGGS, QB_OPS, buildSelect, emptyModel, nextAlias, type Agg, type JoinKind, type QbModel, type QbOp, type QbTable } from '@shared/querybuilder'
import { call, fail, toast } from '../lib/api'
import { useWs } from '../lib/ws'
import { Modal, menuAt } from '../components/ui'
import { Icon } from '../components/Icon'
import '../styles/querybuilder.css'

const W = 210 // card width; header and row heights match querybuilder.css
const HEAD = 30
const ROW = 22
type Meta = Record<string, { cols: Column[]; fks: ForeignKey[] }> // by alias
const key = (t: string, c: string): string => `${t}\u0000${c}`
const unkey = (k: string): [string, string] => k.split('\u0000') as [string, string]

export function QueryBuilder({ onUse, useLabel, onClose }: { onUse: (sql: string) => void; useLabel: string; onClose: () => void }): ReactNode {
  const sessionId = useWs((s) => s.sessionId)
  const dialect = useWs((s) => s.dialect) ?? 'postgres'
  const schema = useWs((s) => s.schema)
  const objects = useWs((s) => s.objects)
  const [m, setM] = useState<QbModel>(emptyModel)
  const [meta, setMeta] = useState<Meta>({})
  const [q, setQ] = useState('')
  const [drag, setDrag] = useState<{ alias: string; dx: number; dy: number } | null>(null)
  const sql = useMemo(() => buildSelect(dialect, m), [dialect, m])
  const tables = objects.filter((o) => (o.kind === 'table' || o.kind === 'view' || o.kind === 'matview') && (!schema || dialect !== 'postgres' || o.schema === schema) && o.name.toLowerCase().includes(q.trim().toLowerCase()))

  const add = async (o: DbObject): Promise<void> => {
    if (!sessionId) return
    try {
      const [cols, fks] = await Promise.all([call<Column[]>('db.columns', sessionId, o.schema, o.name), call<ForeignKey[]>('db.fks', sessionId, o.schema, o.name).catch(() => [])])
      setM((cur) => {
        const alias = nextAlias(cur, o.name)
        const n = cur.tables.length
        const t: QbTable = { alias, schema: o.schema, name: o.name, x: 16 + (n % 4) * (W + 40), y: 16 + Math.floor(n / 4) * 240 }
        // foreign keys between the new table and the ones already there become joins
        const joins = [...cur.joins]
        for (const other of cur.tables) {
          for (const fk of fks) if (fk.refTable === other.name && (fk.refSchema || o.schema) === other.schema) fk.columns.forEach((c, i) => joins.push({ left: other.alias, leftCol: fk.refColumns[i], right: alias, rightCol: c, kind: 'INNER' }))
          for (const fk of meta[other.alias]?.fks ?? []) if (fk.refTable === o.name && (fk.refSchema || other.schema) === o.schema) fk.columns.forEach((c, i) => joins.push({ left: other.alias, leftCol: c, right: alias, rightCol: fk.refColumns[i], kind: 'INNER' }))
        }
        setMeta((x) => ({ ...x, [alias]: { cols, fks } }))
        return { ...cur, tables: [...cur.tables, t], joins: joins.filter((j, i) => joins.findIndex((k) => k.left === j.left && k.leftCol === j.leftCol && k.right === j.right && k.rightCol === j.rightCol) === i) }
      })
    } catch (e) { fail(e) }
  }
  const remove = (alias: string): void => setM((cur) => ({
    ...cur,
    tables: cur.tables.filter((t) => t.alias !== alias),
    columns: cur.columns.filter((c) => c.table !== alias),
    joins: cur.joins.filter((j) => j.left !== alias && j.right !== alias),
    where: cur.where.filter((f) => f.table !== alias),
    sort: cur.sort.filter((s) => s.table !== alias)
  }))
  const toggleCol = (alias: string, col: string, on: boolean): void => setM((cur) => ({ ...cur, columns: on ? [...cur.columns, { table: alias, column: col, agg: '', as: '' }] : cur.columns.filter((c) => !(c.table === alias && c.column === col)) }))
  const join = (from: [string, string], to: [string, string]): void => {
    if (from[0] === to[0]) return
    setM((cur) => cur.joins.some((j) => j.left === from[0] && j.leftCol === from[1] && j.right === to[0] && j.rightCol === to[1]) ? cur : { ...cur, joins: [...cur.joins, { left: from[0], leftCol: from[1], right: to[0], rightCol: to[1], kind: 'INNER' }] })
  }

  useEffect(() => {
    if (!drag) return
    const canvas = document.querySelector('.qb-canvas')
    const move = (e: PointerEvent): void => {
      const r = canvas?.getBoundingClientRect()
      if (!r) return
      const x = Math.max(0, e.clientX - r.left + (canvas?.scrollLeft ?? 0) - drag.dx)
      const y = Math.max(0, e.clientY - r.top + (canvas?.scrollTop ?? 0) - drag.dy)
      setM((cur) => ({ ...cur, tables: cur.tables.map((t) => (t.alias === drag.alias ? { ...t, x, y } : t)) }))
    }
    const up = (): void => setDrag(null)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [drag])

  const allCols = m.tables.flatMap((t) => (meta[t.alias]?.cols ?? []).map((c) => ({ t: t.alias, c })))
  const typeOf = (alias: string, col: string): string => meta[alias]?.cols.find((c) => c.name === col)?.type ?? ''
  const anchor = (alias: string, col: string, side: 'l' | 'r'): [number, number] => {
    const t = m.tables.find((x) => x.alias === alias)!
    const i = Math.max(0, meta[alias]?.cols.findIndex((c) => c.name === col) ?? 0)
    return [t.x + (side === 'r' ? W : 0), t.y + HEAD + i * ROW + ROW / 2]
  }
  const size = m.tables.reduce((s, t) => [Math.max(s[0], t.x + W + 40), Math.max(s[1], t.y + HEAD + (meta[t.alias]?.cols.length ?? 0) * ROW + 40)], [0, 0])
  const colSelect = (value: string, onChange: (k: string) => void, label: string): ReactNode => (
    <select className="select sm" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {allCols.map(({ t, c }) => <option key={key(t, c.name)} value={key(t, c.name)}>{t}.{c.name}</option>)}
    </select>
  )

  return (
    <Modal
      title="Query Builder"
      onClose={onClose}
      width={1240}
      footer={<>
        <span className="grow muted">{m.tables.length ? `${m.tables.length} table${m.tables.length === 1 ? '' : 's'} · ${m.joins.length} join${m.joins.length === 1 ? '' : 's'}` : 'Add a table from the list on the left.'}</span>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={!sql} onClick={() => { void navigator.clipboard.writeText(sql); toast('SQL copied') }}>Copy SQL</button>
        <button className="btn primary" disabled={!sql} onClick={() => { onUse(sql); onClose() }}>{useLabel}</button>
      </>}
    >
      <div className="qb-top">
        <div className="col qb-tables">
          <input className="input sm" placeholder="Filter tables" aria-label="Filter tables" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="qb-list" role="list" aria-label="Tables">
            {tables.map((o) => (
              <button key={`${o.schema}.${o.name}`} role="listitem" className="qb-add" title={`Add ${o.name}`} onClick={() => void add(o)}>
                <Icon name={o.kind === 'table' ? 'table' : 'view'} size={12} /> <span className="ellipsis">{o.name}</span>
              </button>
            ))}
            {!tables.length && <div className="muted" style={{ padding: 'var(--sp-3)' }}>No tables.</div>}
          </div>
        </div>
        <div className="qb-canvas" aria-label="Query canvas">
          <div style={{ position: 'relative', width: size[0], height: size[1], minWidth: '100%', minHeight: '100%' }}>
            <svg className="qb-lines" width={size[0]} height={size[1]} aria-hidden>
              {m.joins.map((j, i) => {
                const a = m.tables.find((t) => t.alias === j.left), b = m.tables.find((t) => t.alias === j.right)
                if (!a || !b) return null
                const [sa, sb]: ['l' | 'r', 'l' | 'r'] = a.x + W <= b.x ? ['r', 'l'] : b.x + W <= a.x ? ['l', 'r'] : ['r', 'r']
                const [x1, y1] = anchor(j.left, j.leftCol, sa), [x2, y2] = anchor(j.right, j.rightCol, sb)
                const c1 = x1 + (sa === 'r' ? 40 : -40), c2 = x2 + (sb === 'r' ? 40 : -40)
                return <path key={i} d={`M${x1},${y1} C${c1},${y1} ${c2},${y2} ${x2},${y2}`} />
              })}
            </svg>
            {m.joins.map((j, i) => {
              const a = m.tables.find((t) => t.alias === j.left), b = m.tables.find((t) => t.alias === j.right)
              if (!a || !b) return null
              const [x1, y1] = anchor(j.left, j.leftCol, a.x + W <= b.x ? 'r' : 'l'), [x2, y2] = anchor(j.right, j.rightCol, a.x + W <= b.x ? 'l' : 'r')
              return (
                <button key={i} className="qb-join" style={{ left: (x1 + x2) / 2, top: (y1 + y2) / 2 }} aria-label={`${j.kind} join ${j.left}.${j.leftCol} = ${j.right}.${j.rightCol}`}
                  onClick={(e) => menuAt(e, [
                    ...(['INNER', 'LEFT', 'RIGHT', 'FULL'] as JoinKind[]).map((k) => ({ label: k === 'INNER' ? 'Inner join (matching rows only)' : k === 'LEFT' ? `Left join (all of ${j.left})` : k === 'RIGHT' ? `Right join (all of ${j.right})` : 'Full join (all of both)', checked: j.kind === k, onClick: () => setM((cur) => ({ ...cur, joins: cur.joins.map((x, k2) => (k2 === i ? { ...x, kind: k } : x)) })) })),
                    { sep: true },
                    { label: 'Remove join', danger: true, onClick: () => setM((cur) => ({ ...cur, joins: cur.joins.filter((_x, k2) => k2 !== i) })) }
                  ])}>{j.kind}</button>
              )
            })}
            {m.tables.map((t) => (
              <section key={t.alias} className="qb-card" style={{ left: t.x, top: t.y, width: W }} aria-label={`Table ${t.alias}`}>
                <header onPointerDown={(e) => { if ((e.target as HTMLElement).closest('button')) return; const r = e.currentTarget.parentElement!.getBoundingClientRect(); setDrag({ alias: t.alias, dx: e.clientX - r.left, dy: e.clientY - r.top }) }}>
                  <b className="ellipsis grow">{t.name}{t.alias !== t.name && <span className="faint"> {t.alias}</span>}</b>
                  <button className="btn ghost icon sm" aria-label={`Remove ${t.alias}`} onClick={() => remove(t.alias)}><Icon name="x" size={10} /></button>
                </header>
                {(meta[t.alias]?.cols ?? []).map((c) => (
                  <label key={c.name} className="qb-col" draggable title="Drag onto a column of another table to join them"
                    onDragStart={(e) => e.dataTransfer.setData('text/qb', JSON.stringify([t.alias, c.name]))}
                    onDragOver={(e) => { if (e.dataTransfer.types.includes('text/qb')) e.preventDefault() }}
                    onDrop={(e) => { e.preventDefault(); const from = JSON.parse(e.dataTransfer.getData('text/qb')) as [string, string]; join(from, [t.alias, c.name]) }}>
                    <input type="checkbox" aria-label={`Select ${t.alias}.${c.name}`} checked={m.columns.some((x) => x.table === t.alias && x.column === c.name)} onChange={(e) => toggleCol(t.alias, c.name, e.target.checked)} />
                    <span className="ellipsis grow">{c.pk && <Icon name="key" size={9} />} {c.name}</span>
                    <span className="faint mono ellipsis" style={{ maxWidth: 70 }}>{c.type}</span>
                  </label>
                ))}
              </section>
            ))}
          </div>
        </div>
      </div>

      <div className="qb-bottom">
        <div className="col" style={{ gap: 'var(--sp-4)', minWidth: 0 }}>
          <fieldset className="fieldset">
            <legend>Columns</legend>
            {!m.columns.length && <div className="muted">Tick columns on the canvas; none ticked selects everything.</div>}
            {m.columns.map((c, i) => (
              <div key={key(c.table, c.column)} className="row qb-line">
                <span className="mono ellipsis" style={{ width: 180 }}>{c.table}.{c.column}</span>
                <select className="select sm" aria-label={`Function for ${c.table}.${c.column}`} value={c.agg} onChange={(e) => setM((cur) => ({ ...cur, columns: cur.columns.map((x, k) => (k === i ? { ...x, agg: e.target.value as Agg } : x)) }))}>
                  {AGGS.map((a) => <option key={a} value={a}>{a || 'Value'}</option>)}
                </select>
                <input className="input sm" placeholder="Name in result" aria-label={`Alias for ${c.table}.${c.column}`} value={c.as} onChange={(e) => setM((cur) => ({ ...cur, columns: cur.columns.map((x, k) => (k === i ? { ...x, as: e.target.value } : x)) }))} />
              </div>
            ))}
          </fieldset>
          <fieldset className="fieldset">
            <legend>Conditions</legend>
            {m.where.map((f, i) => (
              <div key={i} className="row qb-line">
                {colSelect(key(f.table, f.column), (k) => { const [t, c] = unkey(k); setM((cur) => ({ ...cur, where: cur.where.map((x, n) => (n === i ? { ...x, table: t, column: c, type: typeOf(t, c) } : x)) })) }, `Condition ${i + 1} column`)}
                <select className="select sm" aria-label={`Condition ${i + 1} operator`} value={f.op} onChange={(e) => setM((cur) => ({ ...cur, where: cur.where.map((x, n) => (n === i ? { ...x, op: e.target.value as QbOp } : x)) }))}>
                  {QB_OPS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                {f.op !== 'IS NULL' && f.op !== 'IS NOT NULL' && <input className="input sm grow" aria-label={`Condition ${i + 1} value`} placeholder={f.op.endsWith('IN') ? 'a, b, c' : f.op.endsWith('LIKE') ? '%text%' : 'Value'} value={f.value} onChange={(e) => setM((cur) => ({ ...cur, where: cur.where.map((x, n) => (n === i ? { ...x, value: e.target.value } : x)) }))} />}
                <button className="btn ghost icon sm" aria-label={`Remove condition ${i + 1}`} onClick={() => setM((cur) => ({ ...cur, where: cur.where.filter((_x, n) => n !== i) }))}><Icon name="x" size={10} /></button>
              </div>
            ))}
            <div className="row">
              <button className="btn sm" disabled={!allCols.length} onClick={() => setM((cur) => ({ ...cur, where: [...cur.where, { table: allCols[0].t, column: allCols[0].c.name, type: allCols[0].c.type, op: '=', value: '' }] }))}><Icon name="plus" size={11} /> Add condition</button>
              {m.where.length > 1 && (
                <select className="select sm" style={{ width: 'auto' }} aria-label="Combine conditions with" value={m.whereJoin} onChange={(e) => setM((cur) => ({ ...cur, whereJoin: e.target.value as 'AND' | 'OR' }))}>
                  <option value="AND">all must match (AND)</option>
                  <option value="OR">any may match (OR)</option>
                </select>
              )}
            </div>
          </fieldset>
          <fieldset className="fieldset">
            <legend>Sort and limit</legend>
            {m.sort.map((s, i) => (
              <div key={i} className="row qb-line">
                {colSelect(key(s.table, s.column), (k) => { const [t, c] = unkey(k); setM((cur) => ({ ...cur, sort: cur.sort.map((x, n) => (n === i ? { ...x, table: t, column: c } : x)) })) }, `Sort ${i + 1} column`)}
                <select className="select sm" style={{ width: 'auto' }} aria-label={`Sort ${i + 1} direction`} value={s.dir} onChange={(e) => setM((cur) => ({ ...cur, sort: cur.sort.map((x, n) => (n === i ? { ...x, dir: e.target.value as 'ASC' | 'DESC' } : x)) }))}>
                  <option value="ASC">Ascending</option>
                  <option value="DESC">Descending</option>
                </select>
                <button className="btn ghost icon sm" aria-label={`Remove sort ${i + 1}`} onClick={() => setM((cur) => ({ ...cur, sort: cur.sort.filter((_x, n) => n !== i) }))}><Icon name="x" size={10} /></button>
              </div>
            ))}
            <div className="row">
              <button className="btn sm" disabled={!allCols.length} onClick={() => setM((cur) => ({ ...cur, sort: [...cur.sort, { table: allCols[0].t, column: allCols[0].c.name, dir: 'ASC' }] }))}><Icon name="plus" size={11} /> Add sort</button>
              <label className="check"><input type="checkbox" checked={m.distinct} onChange={(e) => setM((cur) => ({ ...cur, distinct: e.target.checked }))} /> Distinct rows</label>
              <label className="check">Limit <input className="input sm" type="number" min={1} style={{ width: 90 }} aria-label="Limit" placeholder="None" value={m.limit ?? ''} onChange={(e) => setM((cur) => ({ ...cur, limit: Number(e.target.value) > 0 ? Number(e.target.value) : null }))} /></label>
            </div>
          </fieldset>
        </div>
        <pre className="code qb-sql selectable" aria-label="SQL">{sql || '-- The SELECT appears here as you build it.'}</pre>
      </div>
    </Modal>
  )
}
