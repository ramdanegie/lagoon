import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { PG_ATTRS, PG_TABLE_PRIVS, MYSQL_GLOBAL_GROUPS, MYSQL_DB_PRIVS, blankUser, userKey, scopeKey, userSql, redactSql, type UserState } from '@shared/usersql'
import { call, errText, toast, uid } from '../lib/api'
import { useWs, guard, busy, registerTabApi, bumpPending, type Tab } from '../lib/ws'
import { Icon } from '../components/Icon'
import { menuAt } from '../components/ui'
import '../styles/admin.css'

type D = 'postgres' | 'mysql'
type Target = { schema: string; table: string }
/** One user as loaded (orig) and as edited (cur). orig null = new, cur null = staged for deletion. */
interface Row { id: string; orig: UserState | null; cur: UserState | null; password: string; confirm: string; error?: string }
interface Plan { stmts: string[]; problem?: string }

const MYSQL_GLOBAL = MYSQL_GLOBAL_GROUPS.flatMap(([, p]) => p)
const loaded = (u: UserState): Row => ({ id: userKey(u), orig: u, cur: structuredClone(u), password: '', confirm: '' })

function plan(d: D, r: Row): Plan {
  if (r.cur && r.password !== r.confirm) return { stmts: [], problem: 'The two passwords do not match.' }
  try { return { stmts: userSql(d, r.orig, r.cur, r.password) } } catch (e) { return { stmts: [], problem: errText(e) } }
}

export function UserManagement({ tab }: { tab: Tab }): ReactNode {
  const sessionId = useWs((s) => s.sessionId)
  const d: D = useWs((s) => s.dialect) === 'mysql' ? 'mysql' : 'postgres'
  const [rows, setRows] = useState<Row[]>([])
  const [targets, setTargets] = useState<Target[]>([])
  const [selId, setSelId] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [pane, setPane] = useState<'general' | 'global' | 'scoped'>('general')
  const [target, setTarget] = useState<Target | null>(null)
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(true)
  const nameRef = useRef<HTMLInputElement>(null)
  const fid = (s: string): string => `${tab.id}-${s}`

  const plans = new Map(rows.map((r) => [r.id, plan(d, r)]))
  const dirty = (r: Row): boolean => { const p = plans.get(r.id)!; return p.stmts.length > 0 || !!p.problem }
  const pending = rows.filter(dirty).length

  /** Reload from the server. Rows in `keep` failed to apply: they stay staged, re-based when part of them went through. */
  const load = async (keep = new Map<string, { error: string; applied: number }>()): Promise<Row[] | null> => {
    setLoading(true)
    try {
      const [users, t] = await Promise.all([call<UserState[]>('users.list', sessionId), call<Target[]>('users.targets', sessionId)])
      const next = users.map(loaded)
      for (const r of live.current.rows.filter((x) => keep.has(x.id))) {
        const k = keep.get(r.id)!
        const base = k.applied === 0 ? r.orig : (users.find((u) => r.cur && userKey(u) === userKey(r.cur)) ?? users.find((u) => r.orig && userKey(u) === userKey(r.orig)) ?? null)
        const row: Row = { ...r, id: base ? userKey(base) : r.id, orig: base, error: k.error }
        const i = next.findIndex((x) => x.id === row.id)
        if (i >= 0) next[i] = row
        else next.push(row)
      }
      setRows(next)
      setTargets(t)
      setLoadError('')
      return next
    } catch (e) {
      setLoadError(errText(e))
      return null
    } finally {
      setLoading(false)
    }
  }

  const apply = async (): Promise<boolean> => {
    const work = live.current.rows.map((r) => ({ r, p: plan(d, r) })).filter((x) => x.p.stmts.length || x.p.problem)
    const bad = work.find((x) => x.p.problem)
    if (bad) {
      setRows((rs) => rs.map((r) => (r.id === bad.r.id ? { ...r, error: bad.p.problem } : r)))
      setSelId(bad.r.id)
      setPane('general')
      return false
    }
    if (!work.length || !(await guard(work.flatMap((x) => x.p.stmts).map(redactSql)))) return false
    const keep = new Map<string, { error: string; applied: number }>()
    for (const { r, p } of work) {
      const res = await busy(call<{ ok: boolean; index?: number; error?: string }>('users.apply', sessionId, p.stmts)).catch((e) => ({ ok: false, index: 0, error: errText(e) }))
      if (!res.ok) keep.set(r.id, { error: `${res.error}\n${redactSql(p.stmts[res.index ?? 0])}`, applied: res.index ?? 0 })
    }
    const was = live.current.rows.find((r) => r.id === live.current.selId)
    const next = await load(keep)
    const want = was?.cur ? userKey(was.cur) : null
    if (next) setSelId(next.some((r) => r.id === want) ? want : next.some((r) => r.id === was?.id) ? was!.id : null)
    if (!keep.size) toast('User changes applied', 'success')
    return !keep.size
  }

  // the toolbar's Preview / Commit / Discard read the latest render through this ref
  const live = useRef({ rows, selId, pending, apply, load, preview: (): string[] => [] })
  useLayoutEffect(() => { live.current = { rows, selId, pending, apply, load, preview: () => rows.flatMap((r) => plans.get(r.id)!.stmts).map(redactSql) } })
  useEffect(() => {
    registerTabApi(tab.id, { pendingCount: () => live.current.pending, previewSql: () => live.current.preview(), commit: () => live.current.apply(), discard: () => void live.current.load() })
    void load().then((n) => n?.[0] && setSelId((s) => s ?? n[0].id))
    return () => registerTabApi(tab.id, null)
  }, [tab.id])
  useEffect(bumpPending, [rows])

  const row = rows.find((r) => r.id === selId) ?? null
  const u = row?.cur ?? null
  const update = (id: string, f: (r: Row) => Row): void => setRows((rs) => rs.map((r) => (r.id === id ? { ...f(r), error: undefined } : r)))
  const patch = (p: Partial<UserState>): void => { if (row) update(row.id, (r) => ({ ...r, cur: { ...r.cur!, ...p } })) }
  const add = (): void => {
    const r: Row = { id: uid(), orig: null, cur: blankUser(d), password: '', confirm: '' }
    setRows((rs) => [...rs, r])
    setSelId(r.id)
    setPane('general')
    setTimeout(() => nameRef.current?.focus())
  }
  const remove = (id: string): void => setRows((rs) => rs.flatMap((r) => (r.id !== id ? [r] : r.orig ? [{ ...r, cur: null, password: '', confirm: '', error: undefined }] : [])))
  const label = (r: Row): string => { const x = (r.cur ?? r.orig)!; return (x.name || 'New user') + (d === 'mysql' ? `@${x.host}` : '') }
  const shown = rows.filter((r) => label(r).toLowerCase().includes(q.toLowerCase()))

  const listKeys = (e: React.KeyboardEvent): void => {
    const i = shown.findIndex((r) => r.id === selId)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = shown[Math.max(0, Math.min(shown.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (n) { setSelId(n.id); document.getElementById(fid(`u-${n.id}`))?.focus() }
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && row) { e.preventDefault(); remove(row.id) }
  }

  return (
    <div className="um">
      <div className="um-side">
        <div className="search"><input className="input sm" style={{ width: '100%' }} placeholder="Filter users" aria-label="Filter users" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="um-users" role="listbox" aria-label="Users" onKeyDown={listKeys} onContextMenu={(e) => menuAt(e, [{ label: 'New User', onClick: add }])}>
          {loading && !rows.length && <div className="empty">Loading…</div>}
          {shown.map((r) => (
            <button
              key={r.id}
              id={fid(`u-${r.id}`)}
              role="option"
              aria-selected={r.id === selId}
              className={`list-item adm-item ${r.id === selId ? 'selected' : ''} ${r.cur ? '' : 'deleted'}`}
              onClick={() => setSelId(r.id)}
              onContextMenu={(e) => { setSelId(r.id); menuAt(e, [{ label: 'New User', onClick: add }, { sep: true }, r.cur ? { label: 'Delete', danger: true, onClick: () => remove(r.id) } : { label: 'Undo Delete', onClick: () => update(r.id, (x) => ({ ...x, cur: structuredClone(x.orig) })) }]) }}
            >
              <Icon name="user" size={13} className="faint" />
              <span className="ellipsis">{label(r)}</span>
              {dirty(r) && <span className="um-dirty" aria-label="Unsaved changes" title={r.orig ? (r.cur ? 'Edited' : 'Will be deleted') : 'New'} />}
            </button>
          ))}
        </div>
        <div className="um-foot">
          <button className="btn sm" onClick={add}><Icon name="plus" size={11} />New user</button>
          <button className="btn sm ghost" disabled={!row?.cur} onClick={() => row && remove(row.id)}><Icon name="minus" size={11} />Delete</button>
        </div>
      </div>

      <div className="um-main">
        <div className="um-head">
          <div className="tabs" role="tablist" aria-label="User settings">
            {([['general', 'General'], ['global', 'Global privileges'], ['scoped', d === 'mysql' ? 'Database privileges' : 'Table privileges']] as const).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={pane === k} className={pane === k ? 'on' : ''} onClick={() => setPane(k)}>{l}</button>
            ))}
          </div>
          <span className="grow" />
          {pending > 0 && <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>{pending} user{pending > 1 ? 's' : ''} changed</span>}
          <button className="btn" disabled={!pending && !loadError} onClick={() => void load()}>{loadError ? 'Reload' : 'Revert'}</button>
          <button className="btn primary" disabled={!pending} onClick={() => void apply()}>Apply</button>
        </div>
        <div className="um-body">
          {loadError && <div className="um-error" role="alert">{loadError}</div>}
          {row?.error && <div className="um-error" role="alert">{row.error}</div>}
          {!row ? (
            !loadError && <div className="empty">Select a user, or create one with New user.</div>
          ) : !u ? (
            <div className="empty">
              <div><b>{label(row)}</b> will be deleted when you apply.</div>
              <button className="btn" onClick={() => update(row.id, (x) => ({ ...x, cur: structuredClone(x.orig) }))}>Undo delete</button>
            </div>
          ) : pane === 'general' ? (
            <div className="um-form">
              <div className="field"><label htmlFor={fid('name')}>User name</label><input id={fid('name')} ref={nameRef} className="input" value={u.name} onChange={(e) => patch({ name: e.target.value })} /></div>
              {d === 'mysql' ? (
                <>
                  <div className="field"><label htmlFor={fid('host')}>Host</label><input id={fid('host')} className="input mono" placeholder="%" value={u.host} onChange={(e) => patch({ host: e.target.value })} aria-describedby={fid('host-hint')} /></div>
                  <div className="field"><span /><span id={fid('host-hint')} className="um-hint">Where the account may connect from: % for anywhere, localhost, or a pattern such as 10.0.0.%</span></div>
                </>
              ) : (
                <div className="field"><span /><div><label className="check"><input type="checkbox" checked={u.canLogin} onChange={(e) => patch({ canLogin: e.target.checked })} />Can log in</label></div></div>
              )}
              <div className="field"><label htmlFor={fid('pw')}>Password</label><input id={fid('pw')} type="password" autoComplete="new-password" className="input" placeholder={row.orig ? 'Leave empty to keep the current one' : ''} value={row.password} onChange={(e) => update(row.id, (r) => ({ ...r, password: e.target.value }))} /></div>
              <div className="field"><label htmlFor={fid('pw2')}>Confirm</label><input id={fid('pw2')} type="password" autoComplete="new-password" className="input" aria-invalid={row.password !== row.confirm} value={row.confirm} onChange={(e) => update(row.id, (r) => ({ ...r, confirm: e.target.value }))} /></div>
              {row.password !== row.confirm && row.confirm !== '' && <div className="field"><span /><span className="danger-text">The passwords do not match.</span></div>}
              {d === 'mysql' && (
                <fieldset className="fieldset">
                  <legend>Limits per hour (0 = unlimited)</legend>
                  {([['maxQueries', 'Queries'], ['maxUpdates', 'Updates'], ['maxConnections', 'Connections']] as const).map(([k, l]) => (
                    <div key={k} className="field"><label htmlFor={fid(k)}>{l}</label><input id={fid(k)} type="number" min={0} className="input" value={u[k]} onChange={(e) => patch({ [k]: Math.max(0, Number(e.target.value) || 0) })} /></div>
                  ))}
                </fieldset>
              )}
            </div>
          ) : pane === 'global' ? (
            <GlobalPrivs d={d} u={u} patch={patch} />
          ) : (
            <ScopedPrivs d={d} u={u} patch={patch} targets={targets} target={target} setTarget={setTarget} id={fid('scope')} />
          )}
        </div>
      </div>
    </div>
  )
}

function GlobalPrivs({ d, u, patch }: { d: D; u: UserState; patch: (p: Partial<UserState>) => void }): ReactNode {
  const toggle = (p: string, on: boolean): void => patch({ global: on ? [...u.global, p] : u.global.filter((x) => x !== p) })
  const box = (p: string, l = p): ReactNode => <label key={p} className="check"><input type="checkbox" checked={u.global.includes(p)} onChange={(e) => toggle(p, e.target.checked)} />{l}</label>
  if (d === 'postgres') return <fieldset className="fieldset"><legend>Role attributes</legend><div className="um-privs">{PG_ATTRS.map(([a, l]) => box(a, l))}</div></fieldset>
  const other = u.global.filter((p) => !MYSQL_GLOBAL.includes(p))
  return (
    <>
      <div className="um-warn">Global privileges apply to every database on the server. Granting all of them makes this account as powerful as root.</div>
      <div className="row">
        <button className="btn sm" onClick={() => patch({ global: [...new Set([...u.global, ...MYSQL_GLOBAL])] })}>Check all</button>
        <button className="btn sm" onClick={() => patch({ global: other })}>Uncheck all</button>
      </div>
      {MYSQL_GLOBAL_GROUPS.map(([g, privs]) => <fieldset key={g} className="fieldset"><legend>{g}</legend><div className="um-privs">{privs.map((p) => box(p))}</div></fieldset>)}
      {other.length > 0 && <div className="um-hint">Also granted (kept as is): {other.join(', ')}</div>}
    </>
  )
}

function ScopedPrivs(p: { d: D; u: UserState; patch: (x: Partial<UserState>) => void; targets: Target[]; target: Target | null; setTarget: (t: Target) => void; id: string }): ReactNode {
  const { d, u } = p
  // grants on objects missing from the picker (MySQL wildcard database names) still need to be reachable
  const opts = [...p.targets, ...u.scoped.filter((g) => !p.targets.some((t) => scopeKey(t) === scopeKey(g))).map((g) => ({ schema: g.schema, table: g.table }))]
  const tgt = p.target ?? u.scoped[0] ?? opts[0] ?? null
  if (!tgt) return <div className="empty">{d === 'mysql' ? 'No databases to grant on.' : 'No tables in this database to grant on.'}</div>
  const k = scopeKey(tgt)
  const universe = d === 'mysql' ? MYSQL_DB_PRIVS : PG_TABLE_PRIVS
  const has = u.scoped.find((g) => scopeKey(g) === k)?.privs ?? []
  const granted = [...universe.filter((x) => has.includes(x)), ...has.filter((x) => !universe.includes(x))]
  const setPrivs = (privs: string[]): void => {
    const scoped = u.scoped.some((g) => scopeKey(g) === k) ? u.scoped.map((g) => (scopeKey(g) === k ? { ...g, privs } : g)) : [...u.scoped, { ...tgt, privs }]
    p.patch({ scoped: scoped.filter((g) => g.privs.length) })
  }
  const count = (t: Target): string => { const n = u.scoped.find((g) => scopeKey(g) === scopeKey(t))?.privs.length; return n ? ` (${n})` : '' }
  const schemas = [...new Set(opts.map((t) => t.schema))]
  return (
    <>
      <div className="row">
        {d === 'mysql' ? (
          <>
            <label className="muted" htmlFor={`${p.id}-db`}>Database</label>
            <select id={`${p.id}-db`} className="select" value={tgt.schema} onChange={(e) => p.setTarget({ schema: e.target.value, table: '' })}>
              {opts.map((t) => <option key={t.schema} value={t.schema}>{t.schema}{count(t)}</option>)}
            </select>
          </>
        ) : (
          <>
            <label className="muted" htmlFor={`${p.id}-schema`}>Schema</label>
            <select id={`${p.id}-schema`} className="select" value={tgt.schema} onChange={(e) => p.setTarget(opts.find((t) => t.schema === e.target.value)!)}>
              {schemas.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <label className="muted" htmlFor={`${p.id}-table`}>Table</label>
            <select id={`${p.id}-table`} className="select" value={tgt.table} onChange={(e) => p.setTarget({ schema: tgt.schema, table: e.target.value })}>
              {opts.filter((t) => t.schema === tgt.schema).map((t) => <option key={t.table} value={t.table}>{t.table}{count(t)}</option>)}
            </select>
          </>
        )}
      </div>
      <DualList id={p.id} available={universe.filter((x) => !has.includes(x))} granted={granted} onChange={setPrivs} />
      {u.scoped.length > 0 && (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <span className="um-hint">Has privileges on:</span>
          {u.scoped.map((g) => <button key={scopeKey(g)} className={`btn sm ${scopeKey(g) === k ? 'on' : 'ghost'}`} onClick={() => p.setTarget(g)}>{g.table ? `${g.schema}.${g.table}` : g.schema}</button>)}
        </div>
      )}
    </>
  )
}

/** Available ⇄ Granted lists: move with the arrow buttons, double-click, or Enter. */
function DualList({ id, available, granted, onChange }: { id: string; available: string[]; granted: string[]; onChange: (privs: string[]) => void }): ReactNode {
  const a = useRef<HTMLSelectElement>(null)
  const g = useRef<HTMLSelectElement>(null)
  const picked = (r: React.RefObject<HTMLSelectElement | null>): string[] => Array.from(r.current?.selectedOptions ?? [], (o) => o.value)
  const grant = (): void => { const x = picked(a); if (x.length) onChange([...granted, ...x]) }
  const revoke = (): void => { const x = picked(g); if (x.length) onChange(granted.filter((p) => !x.includes(p))) }
  return (
    <div className="um-dual">
      <div className="col">
        <label className="muted" htmlFor={`${id}-avail`}>Available</label>
        <select id={`${id}-avail`} ref={a} multiple className="select" onDoubleClick={grant} onKeyDown={(e) => e.key === 'Enter' && grant()}>
          {available.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
      <div className="moves">
        <button className="btn sm" title="Grant selected" aria-label="Grant selected privileges" onClick={grant}><Icon name="chevronRight" size={12} /></button>
        <button className="btn sm" title="Revoke selected" aria-label="Revoke selected privileges" onClick={revoke}><Icon name="chevronLeft" size={12} /></button>
      </div>
      <div className="col">
        <label className="muted" htmlFor={`${id}-granted`}>Granted</label>
        <select id={`${id}-granted`} ref={g} multiple className="select" onDoubleClick={revoke} onKeyDown={(e) => e.key === 'Enter' && revoke()}>
          {granted.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
    </div>
  )
}
