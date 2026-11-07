import { type ReactNode, useRef } from 'react'
import type { Column, Dialect, Filter, FilterOp } from '@shared/types'
import { FILTER_OPS, whereSql } from '@shared/sqlgen'
import { uid } from '../lib/api'
import { Icon } from '../components/Icon'
import { menuBelow } from '../components/ui'

export const newFilter = (columns: Column[], defCol: string, defOp: string): Filter => {
  const pk = columns.find((c) => c.pk)?.name
  const column = defCol === 'any' ? '__any__' : defCol === 'raw' ? '__raw__' : pk ?? '__any__'
  return { id: uid(), enabled: true, column, op: (defOp as FilterOp) ?? '=', value: '' }
}

const NO_VALUE = ['IS NULL', 'IS NOT NULL']

export function FilterPanel(props: {
  dialect: Dialect
  columns: Column[]
  filters: Filter[]
  join: 'AND' | 'OR'
  applied: string // JSON of the applied filter set, to show "Applied" state
  onChange: (f: Filter[]) => void
  onApply: (f: Filter[], join: 'AND' | 'OR') => void
  onClose: () => void
  defaults: { column: string; op: string }
}): ReactNode {
  const { filters, onChange } = props
  const rowRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const set = (id: string, patch: Partial<Filter>): void => onChange(filters.map((f) => (f.id === id ? { ...f, ...patch } : f)))
  const add = (after?: Filter): void => {
    const f = after ? { ...after, id: uid(), value: after.value } : newFilter(props.columns, props.defaults.column, props.defaults.op)
    const i = after ? filters.findIndex((x) => x.id === after.id) + 1 : filters.length
    const next = [...filters]
    next.splice(i, 0, f)
    onChange(next)
    setTimeout(() => rowRefs.current[f.id]?.focus())
  }
  const remove = (id: string): void => {
    const next = filters.filter((f) => f.id !== id)
    if (!next.length) { props.onApply([], props.join); props.onClose() } else onChange(next)
  }
  const ops = FILTER_OPS[props.dialect]
  const appliedSet = props.applied

  return (
    <div className="filters" role="region" aria-label="Filters">
      {filters.map((f) => {
        const isApplied = appliedSet.includes(`"${f.id}"`) && JSON.stringify(f) === JSON.stringify((JSON.parse(appliedSet) as Filter[]).find((x) => x.id === f.id))
        return (
          <div
            key={f.id}
            className="filter-row"
            onKeyDown={(e) => {
              const mod = e.metaKey || e.ctrlKey
              if (mod && e.key === 'i' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); add(f) }
              else if (mod && e.key.toLowerCase() === 'i' && e.shiftKey) { e.preventDefault(); e.stopPropagation(); remove(f.id) }
              else if (mod && e.key === 'b') { e.preventDefault(); set(f.id, { enabled: !f.enabled }) }
              else if (mod && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); props.onApply(filters, props.join) }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (f.value && (e.target as HTMLElement).tagName === 'INPUT') set(f.id, { value: '' }); else props.onClose() }
            }}
          >
            <input type="checkbox" aria-label="Use this filter" checked={f.enabled} onChange={(e) => set(f.id, { enabled: e.target.checked })} />
            <select className="select sm" aria-label="Column" style={{ maxWidth: 200 }} value={f.column} onChange={(e) => set(f.id, { column: e.target.value })}>
              <option value="__any__">Any column</option>
              <option value="__raw__">Raw SQL</option>
              <option disabled>──────</option>
              {props.columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
            {f.column !== '__raw__' && (
              <select className="select sm" aria-label="Operator" value={f.op} onChange={(e) => set(f.id, { op: e.target.value as FilterOp })}>
                {ops.map((o) => <option key={o}>{o}</option>)}
              </select>
            )}
            {!NO_VALUE.includes(f.op) || f.column === '__raw__' ? (
              <input
                ref={(el) => { rowRefs.current[f.id] = el }}
                className="input sm grow mono"
                aria-label="Value"
                placeholder={f.column === '__raw__' ? "e.g. total > 100 AND status = 'paid'" : f.op.includes('BETWEEN') ? '1 AND 100' : f.op.includes('IN') ? '1, 2, 3' : 'Value'}
                value={f.value}
                onChange={(e) => set(f.id, { value: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) props.onApply(filters.map((x) => (x.id === f.id ? { ...x, enabled: true } : { ...x, enabled: false })), props.join) }}
              />
            ) : <span className="grow" />}
            <button className={`btn sm ${isApplied ? 'on' : ''}`} onClick={() => props.onApply(filters.map((x) => (x.id === f.id ? { ...x, enabled: true } : { ...x, enabled: false })), props.join)}>{isApplied ? 'Applied' : 'Apply'}</button>
            <button className="btn sm icon" aria-label="Add filter" title="Add filter (⌘I)" onClick={() => add(f)}><Icon name="plus" size={10} /></button>
            <button className="btn sm icon" aria-label="Remove filter" title="Remove filter (⇧⌘I)" onClick={() => remove(f.id)}><Icon name="minus" size={10} /></button>
          </div>
        )
      })}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <span className="faint" style={{ fontSize: 'var(--fs-xs)', marginRight: 'auto' }}>{filters.filter((f) => f.enabled).length} of {filters.length} checked · joined with {props.join}</span>
        <button className="btn sm ghost" onClick={(e) => menuBelow(e.currentTarget, [{ header: 'Generated condition' }, { label: whereSql(props.dialect, filters, props.join, props.columns).replace(/^ WHERE /, '') || '(none)', onClick: () => void navigator.clipboard.writeText(whereSql(props.dialect, filters, props.join, props.columns)) }])}>SQL</button>
        <button className="btn sm ghost" onClick={() => { onChange([newFilter(props.columns, props.defaults.column, props.defaults.op)]); props.onApply([], props.join) }}>Clear</button>
        <div className="seg">
          <button onClick={() => props.onApply(filters, 'AND')} title="Apply all checked filters (⌘↩)">Apply All</button>
          <button aria-label="Apply options" onClick={(e) => menuBelow(e.currentTarget, [{ label: 'Apply checked filters with AND', checked: props.join === 'AND', onClick: () => props.onApply(filters, 'AND') }, { label: 'Apply checked filters with OR', checked: props.join === 'OR', onClick: () => props.onApply(filters, 'OR') }])}><Icon name="chevronDown" size={10} /></button>
        </div>
      </div>
    </div>
  )
}
