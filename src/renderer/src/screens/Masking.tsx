// "Mask sensitive columns" for exports and transfers: an on/off switch plus the shared rule list (kept in settings).
import type { ReactNode } from 'react'
import { MASK_METHODS, MASK_PRESETS, maskedColumns, type MaskMethod, type MaskRule } from '@shared/masking'
import { useSetting } from '../lib/api'
import { Icon } from '../components/Icon'

export const useMaskRules = (): [MaskRule[], (r: MaskRule[]) => void] => useSetting<MaskRule[]>('masking.rules', MASK_PRESETS)

/** `columns`: names in what is being exported, to show which ones the rules hit. */
export function MaskingOptions({ on, setOn, columns }: { on: boolean; setOn: (v: boolean) => void; columns?: string[] }): ReactNode {
  const [rules, setRules] = useMaskRules()
  const patch = (i: number, p: Partial<MaskRule>): void => setRules(rules.map((r, k) => (k === i ? { ...r, ...p } : r)))
  const hit = columns && maskedColumns(columns, rules)
  return (
    <fieldset className="fieldset">
      <legend>Masking</legend>
      <label className="check"><input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> Mask sensitive columns</label>
      {on && (
        <>
          <div className="muted" style={{ fontSize: 'var(--fs-sm)' }}>Columns whose name matches a pattern (* = anything) are rewritten in the output. The database is not changed.</div>
          <div className="col" role="list" aria-label="Masking rules" style={{ gap: 'var(--sp-2)' }}>
            {rules.map((r, i) => {
              const m = MASK_METHODS.find((x) => x.id === r.method)
              return (
                <div key={i} role="listitem" className="row" style={{ gap: 'var(--sp-2)' }}>
                  <input className="input sm mono" style={{ width: 140 }} aria-label={`Column pattern ${i + 1}`} value={r.column} onChange={(e) => patch(i, { column: e.target.value })} />
                  <select className="select sm" aria-label={`Masking for ${r.column || `rule ${i + 1}`}`} value={r.method} onChange={(e) => patch(i, { method: e.target.value as MaskMethod })}>
                    {MASK_METHODS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                  </select>
                  {m?.arg && <input className="input sm" style={{ width: 90 }} aria-label={`${m.arg} for ${r.column || `rule ${i + 1}`}`} placeholder={m.arg} value={r.arg ?? ''} onChange={(e) => patch(i, { arg: e.target.value })} />}
                  <button className="btn ghost icon sm" aria-label={`Remove rule ${r.column || i + 1}`} onClick={() => setRules(rules.filter((_x, k) => k !== i))}><Icon name="x" size={10} /></button>
                </div>
              )
            })}
          </div>
          <div className="row">
            <button className="btn sm" onClick={() => setRules([...rules, { column: '', method: 'fixed', arg: 'redacted' }])}><Icon name="plus" size={11} /> Add rule</button>
            <button className="btn sm ghost" onClick={() => setRules(MASK_PRESETS)}>Reset to common rules</button>
          </div>
          {hit && <div className={hit.length ? '' : 'muted'} style={{ fontSize: 'var(--fs-sm)' }}>{hit.length ? `Masked here: ${hit.join(', ')}` : 'No column here matches these rules.'}</div>}
        </>
      )}
    </fieldset>
  )
}
