// ER diagram of one schema: table boxes, FK lines, pan/zoom, search, saved layout, staged FK edits, image export.
import { type ReactNode, type MouseEvent as RME, useEffect, useMemo, useRef, useState } from 'react'
import type { Column, DbObject, ForeignKey } from '@shared/types'
import { FK_ACTIONS, addForeignKeySql, dropForeignKeySql } from '@shared/sqlgen'
import { call, errText, fail, focusScope, toast, useCommands } from '../lib/api'
import { bumpPending, guard, openTab, registerTabApi, ws, useWs, type Tab } from '../lib/ws'
import { BOX_W, HEAD_H, ROW_H, type DTable, type Pos, type SortMode, autoLayout, bounds, boxHeight, edgesOf, fkGroups, fkPath, mergeLayout } from '../lib/diagram'
import { Icon } from '../components/Icon'
import { Modal, menuAt, menuBelow, type MenuItem } from '../components/ui'
import '../styles/diagram.css'

interface Layout { positions?: Record<string, Pos>; sort?: SortMode; zoom?: number }
interface Staged { add: { table: string; fk: ForeignKey }[]; drop: { table: string; name: string }[] }
interface FkDraft { table: string; column: string; refTable: string; refColumn: string; onUpdate: string; onDelete: string }

const GROUP_COLORS = ['--accent', '--syn-number', '--syn-keyword', '--syn-string', '--syn-ident', '--warning', '--success', '--danger']
const trunc = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const clampK = (k: number): number => Math.min(3, Math.max(0.15, k))

export function Diagram({ tab }: { tab: Tab }): ReactNode {
  const dialect = useWs((s) => s.dialect)
  const schema = tab.schema ?? ws().schema ?? ''
  const layoutKey = `${ws().database ?? ''}.${schema}`
  const editable = !!dialect && dialect !== 'sqlite'

  const [tables, setTables] = useState<DTable[]>([])
  const [progress, setProgress] = useState<{ done: number; total: number } | null>({ done: 0, total: 0 })
  const [error, setError] = useState<string | null>(null)
  const [pos, setPos] = useState<Record<string, Pos>>({})
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const [sort, setSort] = useState<SortMode>('name')
  const [q, setQ] = useState('')
  const [hit, setHit] = useState(0)
  const [sel, setSel] = useState<string | null>(null)
  const [staged, setStaged] = useState<Staged>({ add: [], drop: [] })
  const [fkLine, setFkLine] = useState<{ table: string; row: number; x: number; y: number } | null>(null)
  const [draft, setDraft] = useState<FkDraft | null>(null)

  const svg = useRef<SVGSVGElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const latest = useRef({ pos, sort, view, staged, tables })
  latest.current = { pos, sort, view, staged, tables }
  const scope = `diagram:${tab.id}`
  const ids = { arrow: `${tab.id}-arrow`, add: `${tab.id}-arrow-add`, drop: `${tab.id}-arrow-drop` }

  const byName = useMemo(() => new Map(tables.map((t) => [t.name, t])), [tables])
  const sizes = useMemo(() => tables.map((t) => ({ name: t.name, cols: t.columns.length })), [tables])
  const edges = useMemo(() => edgesOf(tables, schema), [tables, schema])
  const groups = useMemo(() => fkGroups(tables.map((t) => t.name), edges), [tables, edges])
  const matches = useMemo(() => (q.trim() ? tables.filter((t) => t.name.toLowerCase().includes(q.trim().toLowerCase())).map((t) => t.name) : []), [q, tables])

  // ---------- load ----------
  const saveLayout = (): void => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      const { pos: p, sort: s, view: v } = latest.current
      const conn = ws().conn
      if (conn) call('diagram.set', conn.id, layoutKey, { positions: p, sort: s, zoom: v.k } satisfies Layout).catch(fail)
    }, 400)
  }

  const load = async (relayout = false): Promise<void> => {
    const sid = ws().sessionId
    const conn = ws().conn
    if (!sid || !conn) return
    setError(null)
    setProgress({ done: 0, total: 0 })
    try {
      const objs = (await call<DbObject[]>('db.objects', sid, schema)).filter((o) => o.kind === 'table')
      setProgress({ done: 0, total: objs.length })
      const out: DTable[] = new Array(objs.length)
      let next = 0
      let done = 0
      // 6 tables at a time; a table we cannot inspect is drawn empty rather than failing the whole diagram
      const worker = async (): Promise<void> => {
        while (next < objs.length) {
          const i = next++
          const name = objs[i].name
          const [columns, fks] = await Promise.all([
            call<Column[]>('db.columns', sid, schema, name).catch(() => [] as Column[]),
            call<ForeignKey[]>('db.fks', sid, schema, name).catch(() => [] as ForeignKey[])
          ])
          out[i] = { name, columns, fks }
          setProgress({ done: ++done, total: objs.length })
        }
      }
      await Promise.all(Array.from({ length: Math.min(6, objs.length) }, worker))
      const saved = relayout ? undefined : await call<Layout | undefined>('diagram.get', conn.id, layoutKey)
      const s = saved?.sort ?? latest.current.sort
      const sz = out.map((t) => ({ name: t.name, cols: t.columns.length }))
      setTables(out)
      setSort(s)
      setPos(mergeLayout(sz, edgesOf(out, schema), s, saved?.positions))
      if (saved?.zoom) setView((v) => ({ ...v, k: clampK(saved.zoom!) }))
      if (relayout) { setView({ x: 0, y: 0, k: latest.current.view.k }); setTimeout(saveLayout) }
    } catch (e) {
      setError(errText(e))
    } finally {
      setProgress(null)
    }
  }

  useEffect(() => {
    void load()
    const reload = (): void => { if (ws().active === tab.id) void load() }
    window.addEventListener('ws:reload', reload)
    return () => window.removeEventListener('ws:reload', reload)
  }, [schema])

  // ---------- staged FK edits (Preview / Commit / Discard in the workspace toolbar) ----------
  const stmtsOf = (s: Staged): string[] => !dialect ? [] : [
    ...s.drop.map((x) => dropForeignKeySql(dialect, schema, x.table, x.name)),
    ...s.add.map((x) => addForeignKeySql(dialect, schema, x.table, x.fk))
  ]
  useEffect(() => {
    if (!editable) return
    registerTabApi(tab.id, {
      pendingCount: () => latest.current.staged.add.length + latest.current.staged.drop.length,
      previewSql: () => stmtsOf(latest.current.staged),
      commit: async () => {
        const stmts = stmtsOf(latest.current.staged)
        if (!stmts.length || !(await guard(stmts))) return false
        const r = await call<{ ok: boolean; index?: number; error?: string }>('db.commit', ws().sessionId, stmts).catch((e) => ({ ok: false, error: errText(e), index: undefined }))
        if (!r.ok) { toast(`Commit failed${r.index !== undefined ? ` at statement ${r.index + 1}` : ''}: ${r.error}`, 'error'); return false }
        setStaged({ add: [], drop: [] })
        toast('Foreign keys updated', 'success')
        void load()
        return true
      },
      discard: () => setStaged({ add: [], drop: [] })
    })
    return () => registerTabApi(tab.id, null)
  }, [editable, dialect, schema])
  useEffect(() => bumpPending(), [staged])

  // ---------- view ----------
  const center = (name: string): void => {
    const p = latest.current.pos[name]
    const t = byName.get(name)
    const el = svg.current
    if (!p || !t || !el) return
    setView((v) => ({ ...v, x: el.clientWidth / 2 - (p.x + BOX_W / 2) * v.k, y: el.clientHeight / 2 - (p.y + boxHeight(t.columns.length) / 2) * v.k }))
    setSel(name)
  }
  const zoomAt = (factor: number, cx?: number, cy?: number): void => {
    const el = svg.current
    setView((v) => {
      const k = clampK(v.k * factor)
      const px = cx ?? (el ? el.clientWidth / 2 : 0)
      const py = cy ?? (el ? el.clientHeight / 2 : 0)
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k }
    })
    saveLayout()
  }
  // native listener: React's wheel handler is passive, and ctrl+wheel must not zoom the whole window
  useEffect(() => {
    const el = svg.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect()
        zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top)
      } else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  /** Pointer position in diagram coordinates. */
  const toDiagram = (e: { clientX: number; clientY: number }): Pos => {
    const r = svg.current!.getBoundingClientRect()
    const v = latest.current.view
    return { x: (e.clientX - r.left - v.x) / v.k, y: (e.clientY - r.top - v.y) / v.k }
  }
  const drag = (e: RME, move: (dx: number, dy: number, ev: MouseEvent) => void, up?: (ev: MouseEvent) => void): void => {
    e.preventDefault()
    e.stopPropagation()
    const sx = e.clientX
    const sy = e.clientY
    const mm = (ev: MouseEvent): void => move(ev.clientX - sx, ev.clientY - sy, ev)
    const mu = (ev: MouseEvent): void => { window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', mu); up?.(ev) }
    window.addEventListener('mousemove', mm)
    window.addEventListener('mouseup', mu)
  }
  const startPan = (e: RME): void => {
    if (e.button !== 0) return
    ;(e.currentTarget as SVGElement).focus()
    setSel(null)
    const v0 = latest.current.view
    drag(e, (dx, dy) => setView({ ...v0, x: v0.x + dx, y: v0.y + dy }))
  }
  const startMove = (e: RME, name: string): void => {
    if (e.button !== 0) return
    ;(e.currentTarget as SVGElement).focus()
    setSel(name)
    const p0 = latest.current.pos[name]
    const k = latest.current.view.k
    let moved = false
    drag(e, (dx, dy) => { moved = true; setPos((p) => ({ ...p, [name]: { x: Math.round(p0.x + dx / k), y: Math.round(p0.y + dy / k) } })) }, () => moved && saveLayout())
  }
  const startFk = (e: RME, table: string, row: number): void => {
    setFkLine({ table, row, ...toDiagram(e) })
    drag(e, (_dx, _dy, ev) => setFkLine({ table, row, ...toDiagram(ev) }), (ev) => {
      setFkLine(null)
      const target = (document.elementFromPoint(ev.clientX, ev.clientY) as Element | null)?.closest('[data-col]')?.getAttribute('data-col')
      if (!target) return
      const [refTable, refColumn] = JSON.parse(target) as [string, string]
      const column = byName.get(table)!.columns[row].name
      if (refTable === table && refColumn === column) return
      setDraft({ table, column, refTable, refColumn, onUpdate: 'NO ACTION', onDelete: 'NO ACTION' })
    })
  }

  // ---------- menus & commands ----------
  const open = (name: string, view?: 'structure'): void => void openTab({ kind: 'table', title: name, schema, name, objKind: 'table', view })
  const copy = (text: string): void => void navigator.clipboard.writeText(text).then(() => toast(`Copied ${text}`))
  const tableMenu = (e: RME, name: string): void => {
    const col = (e.target as Element).closest('[data-col]')?.getAttribute('data-col')
    const colName = col ? (JSON.parse(col) as [string, string])[1] : undefined
    setSel(name)
    menuAt(e, [
      { label: 'Open', onClick: () => open(name) },
      { label: 'Open structure', onClick: () => open(name, 'structure') },
      { sep: true },
      { label: 'Copy name', onClick: () => copy(name) },
      ...(colName ? [{ label: `Copy column name (${colName})`, onClick: () => copy(colName) }] : [])
    ])
  }
  const sortMenu = (el: HTMLElement): void => menuBelow(el, (['name', 'columns'] as SortMode[]).map((s) => ({
    label: s === 'name' ? 'Name' : 'Column count',
    checked: sort === s,
    onClick: () => { setSort(s); setPos(autoLayout(sizes, edges, s)); setView((v) => ({ ...v, x: 0, y: 0 })); setTimeout(saveLayout) }
  })))
  const jump = (d: number): void => {
    if (!matches.length) return
    const i = (hit + d + matches.length) % matches.length
    setHit(i)
    center(matches[i])
  }
  useCommands(scope, {
    'edit.find': () => { if (ws().active !== tab.id) return false; search.current?.focus(); search.current?.select(); return true }
  })

  // ---------- export ----------
  const exportImage = async (): Promise<void> => {
    const el = svg.current
    if (!el || !tables.length) return
    const path = await call<string | undefined>('dialog.save', { defaultPath: `${schema || ws().database || 'diagram'}.png`, filters: [{ name: 'PNG image', extensions: ['png'] }, { name: 'SVG image', extensions: ['svg'] }] })
    if (!path) return
    const b = bounds(sizes, pos)
    const pad = 24
    const w = Math.ceil(b.w + pad * 2)
    const h = Math.ceil(b.h + pad * 2)
    const clone = el.cloneNode(true) as SVGSVGElement
    clone.querySelectorAll('.dg-dot, .dg-hit, .dg-draft').forEach((n) => n.remove())
    clone.querySelector('.dg-viewport')!.setAttribute('transform', `translate(${pad - b.x},${pad - b.y})`)
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('width', String(w))
    clone.setAttribute('height', String(h))
    clone.setAttribute('viewBox', `0 0 ${w} ${h}`)
    clone.removeAttribute('class')
    clone.querySelector('.dg-bg')!.setAttribute('width', String(w))
    clone.querySelector('.dg-bg')!.setAttribute('height', String(h))
    // a standalone file has no stylesheet: inline every CSS variable
    const cs = getComputedStyle(document.documentElement)
    const text = new XMLSerializer().serializeToString(clone).replace(/var\((--[\w-]+)\)/g, (_m, n: string) => cs.getPropertyValue(n).trim())
    try {
      if (/\.svg$/i.test(path)) await call('file.write', path, text)
      else {
        const img = new Image()
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text)
        await img.decode()
        const scale = Math.min(2, Math.sqrt(120e6 / (w * h)))
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(w * scale)
        canvas.height = Math.round(h * scale)
        const ctx = canvas.getContext('2d')!
        ctx.scale(scale, scale)
        ctx.drawImage(img, 0, 0)
        try {
          await call('file.writeBase64', path, canvas.toDataURL('image/png').split(',')[1])
        } catch (e) {
          // shortcut: PNG needs the main-process 'file.writeBase64' RPC; until it exists the SVG is saved instead
          if (!/Unknown method/.test(errText(e))) throw e
          await call('file.write', path.replace(/\.png$/i, '') + '.svg', text)
          return toast('Saved as SVG: PNG export is not available in this build yet.')
        }
      }
      toast('Diagram exported', 'success')
    } catch (e) { fail(e) }
  }

  // ---------- render ----------
  const droppedKey = new Set(staged.drop.map((d) => `${d.table}.${d.name}`))
  const lines: { key: string; d: string; from: string; to: string; kind: 'fk' | 'add' | 'drop'; menu: MenuItem[] }[] = []
  const pushLine = (table: string, fk: ForeignKey, kind: 'fk' | 'add' | 'drop', menu: MenuItem[], key: string): void => {
    const a = byName.get(table)
    const b = byName.get(fk.refTable)
    if (!a || !b || !pos[table] || !pos[fk.refTable] || (fk.refSchema && fk.refSchema !== schema)) return
    const fr = Math.max(0, a.columns.findIndex((c) => c.name === fk.columns[0]))
    const tr = Math.max(0, b.columns.findIndex((c) => c.name === fk.refColumns[0]))
    lines.push({ key, d: fkPath(pos[table], fr, pos[fk.refTable], tr, table === fk.refTable).d, from: table, to: fk.refTable, kind, menu })
  }
  for (const t of tables) for (const fk of t.fks) {
    const dropped = droppedKey.has(`${t.name}.${fk.name}`)
    pushLine(t.name, fk, dropped ? 'drop' : 'fk', !editable ? [{ header: fk.name }, { label: 'Copy constraint name', onClick: () => copy(fk.name) }] : dropped
      ? [{ header: fk.name }, { label: 'Keep foreign key', onClick: () => setStaged((s) => ({ ...s, drop: s.drop.filter((x) => !(x.table === t.name && x.name === fk.name)) })) }]
      : [{ header: fk.name }, { label: 'Delete foreign key', danger: true, onClick: () => setStaged((s) => ({ ...s, drop: [...s.drop, { table: t.name, name: fk.name }] })) }], `${t.name}.${fk.name}`)
  }
  staged.add.forEach((x, i) => pushLine(x.table, x.fk, 'add', [{ header: 'New foreign key (not committed)' }, { label: 'Remove', danger: true, onClick: () => setStaged((s) => ({ ...s, add: s.add.filter((_y, j) => j !== i) })) }], `add-${i}`))
  const fkCols = (t: DTable): Set<string> => new Set([...t.fks.flatMap((f) => f.columns), ...staged.add.filter((x) => x.table === t.name).flatMap((x) => x.fk.columns)])
  const current = matches[hit % Math.max(1, matches.length)]

  return (
    <div className="dg" onFocusCapture={() => focusScope(scope)}>
      <div className="runbar" role="toolbar" aria-label="Diagram">
        <Icon name="diagram" size={13} />
        <span style={{ fontWeight: 600 }}>{schema || ws().database}</span>
        <span className="faint" style={{ fontSize: 'var(--fs-sm)' }}>{tables.length} tables</span>
        <div className="seg" role="group" aria-label="Zoom">
          <button title="Zoom out" aria-label="Zoom out" onClick={() => zoomAt(1 / 1.2)}><Icon name="minus" size={11} /></button>
          <button title="Reset zoom" aria-label="Reset zoom" style={{ minWidth: 48, fontSize: 'var(--fs-sm)' }} onClick={() => zoomAt(1 / view.k)}>{Math.round(view.k * 100)}%</button>
          <button title="Zoom in" aria-label="Zoom in" onClick={() => zoomAt(1.2)}><Icon name="plus" size={11} /></button>
        </div>
        <button className="btn sm" onClick={(e) => sortMenu(e.currentTarget)}>Sort<Icon name="chevronDown" size={10} /></button>
        <button className="btn sm" title="Reload and lay out again" onClick={() => void load(true)}><Icon name="refresh" size={11} />Rearrange</button>
        <button className="btn sm" disabled={!tables.length} onClick={() => void exportImage()}><Icon name="download" size={11} />Export…</button>
        <span className="grow" />
        <div className="dg-search">
          <Icon name="search" size={12} className="faint" />
          <input
            ref={search}
            className="input sm"
            placeholder="Find table"
            aria-label="Find table"
            value={q}
            onChange={(e) => { setQ(e.target.value); setHit(0) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); if (current) center(current) }
              else if (e.key === 'ArrowDown') { e.preventDefault(); jump(1) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); jump(-1) }
              else if (e.key === 'Escape') setQ('')
            }}
          />
          {q && <span className="faint" style={{ fontSize: 'var(--fs-xs)', minWidth: 32 }}>{matches.length ? `${(hit % matches.length) + 1}/${matches.length}` : '0/0'}</span>}
        </div>
      </div>
      <div className="dg-canvas">
        <svg
          ref={svg}
          className="dg-svg"
          tabIndex={-1}
          fontFamily="var(--font-ui)"
          fontSize={12}
          onMouseDown={(e) => { if (e.target === e.currentTarget || (e.target as Element).classList.contains('dg-bg')) startPan(e) }}
        >
          <defs>
            {([['arrow', 'var(--fg-faint)'], ['add', 'var(--accent)'], ['drop', 'var(--danger)']] as const).map(([k, c]) => (
              <marker key={k} id={ids[k]} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" fill={c} />
              </marker>
            ))}
          </defs>
          <rect className="dg-bg" width="100%" height="100%" fill="var(--bg-app)" />
          <g className="dg-viewport" transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {lines.map((l) => {
              const on = sel === l.from || sel === l.to
              const stroke = l.kind === 'add' ? 'var(--accent)' : l.kind === 'drop' ? 'var(--danger)' : on ? 'var(--accent)' : 'var(--fg-faint)'
              const menu = (e: RME): void => menuAt(e, l.menu)
              return (
                <g key={l.key}>
                  <path d={l.d} fill="none" stroke={stroke} strokeWidth={on ? 2 : 1.25} strokeDasharray={l.kind === 'fk' ? undefined : '5 4'} opacity={l.kind === 'drop' ? 0.7 : 1} markerEnd={`url(#${l.kind === 'fk' ? ids.arrow : ids[l.kind]})`} />
                  <path className="dg-hit" d={l.d} fill="none" stroke="transparent" strokeWidth={10} onContextMenu={menu} onClick={menu} />
                </g>
              )
            })}
            {tables.map((t) => {
              const p = pos[t.name]
              if (!p) return null
              const h = boxHeight(t.columns.length)
              const g = groups[t.name]
              const color = g === undefined ? undefined : `var(${GROUP_COLORS[g % GROUP_COLORS.length]})`
              const isMatch = matches.includes(t.name)
              const fkc = fkCols(t)
              return (
                <g
                  key={t.name}
                  className={`dg-table ${sel === t.name ? 'sel' : ''}`}
                  transform={`translate(${p.x},${p.y})`}
                  tabIndex={0}
                  role="button"
                  aria-label={`Table ${t.name}, ${t.columns.length} columns. Enter opens it.`}
                  onMouseDown={(e) => startMove(e, t.name)}
                  onDoubleClick={() => open(t.name)}
                  onContextMenu={(e) => tableMenu(e, t.name)}
                  onKeyDown={(e) => { if (e.key === 'Enter') open(t.name) }}
                >
                  <rect className="dg-box" width={BOX_W} height={h} rx={6} fill="var(--bg-panel)" stroke={current === t.name ? 'var(--accent)' : isMatch ? 'var(--warning)' : 'var(--border-strong)'} strokeWidth={isMatch || sel === t.name ? 2 : 1} />
                  <path d={`M0,6 a6,6 0 0 1 6,-6 h${BOX_W - 12} a6,6 0 0 1 6,6 v${HEAD_H - 6} h${-BOX_W} z`} fill={color ?? 'var(--bg-hover)'} fillOpacity={color ? 0.3 : 1} />
                  {color && <rect width={4} height={HEAD_H} x={0} y={0} rx={2} fill={color} />}
                  <line x1={0} x2={BOX_W} y1={HEAD_H} y2={HEAD_H} stroke="var(--border)" />
                  <text x={12} y={18} fontWeight={600} fill="var(--fg)">{trunc(t.name, 30)}<title>{t.name}</title></text>
                  {t.columns.map((c, i) => (
                    <g key={c.name} transform={`translate(0,${HEAD_H + i * ROW_H})`} data-col={JSON.stringify([t.name, c.name])}>
                      <rect className="dg-row" width={BOX_W} height={ROW_H} fill="transparent" />
                      {(c.pk || fkc.has(c.name)) && (
                        <g transform="translate(7,4)" style={{ color: c.pk ? 'var(--warning)' : 'var(--accent)' }}>
                          <Icon name={c.pk ? 'key' : 'link'} size={12} />
                        </g>
                      )}
                      <text x={24} y={14} fontFamily="var(--font-mono)" fontSize={11} fill="var(--fg)">{trunc(c.name, 18)}<title>{`${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`}</title></text>
                      <text x={BOX_W - 10} y={14} textAnchor="end" fontFamily="var(--font-mono)" fontSize={11} fill="var(--fg-faint)">{trunc(c.type, 13)}</text>
                      {editable && <circle className="dg-dot" cx={BOX_W} cy={ROW_H / 2} r={4} fill="var(--accent)" stroke="var(--bg-panel)" strokeWidth={1.5} onMouseDown={(e) => startFk(e, t.name, i)}><title>Drag to another column to add a foreign key</title></circle>}
                    </g>
                  ))}
                  {!t.columns.length && <text x={12} y={HEAD_H + 14} fill="var(--fg-faint)" fontSize={11}>No columns</text>}
                </g>
              )
            })}
            {fkLine && pos[fkLine.table] && (
              <path
                className="dg-draft"
                d={`M${pos[fkLine.table].x + BOX_W},${pos[fkLine.table].y + HEAD_H + fkLine.row * ROW_H + ROW_H / 2} L${fkLine.x},${fkLine.y}`}
                stroke="var(--accent)"
                strokeDasharray="4 3"
                fill="none"
                pointerEvents="none"
              />
            )}
          </g>
        </svg>
        {progress && (
          <div className="dg-overlay" role="status">
            <span>{progress.total ? `Loading tables ${progress.done}/${progress.total}` : 'Loading tables…'}</span>
            <div className="dg-progress"><div style={{ width: progress.total ? `${(progress.done / progress.total) * 100}%` : '15%' }} /></div>
          </div>
        )}
        {!progress && error && (
          <div className="dg-overlay" role="alert">
            <span className="danger-text selectable">{error}</span>
            <button className="btn" onClick={() => void load()}>Try again</button>
          </div>
        )}
        {!progress && !error && !tables.length && <div className="dg-overlay">No tables in {schema || 'this database'}</div>}
      </div>
      {draft && (
        <Modal
          title="New foreign key"
          width={420}
          onClose={() => setDraft(null)}
          footer={<>
            <button className="btn" onClick={() => setDraft(null)}>Cancel</button>
            <button className="btn primary" onClick={() => {
              setStaged((s) => ({ ...s, add: [...s.add, { table: draft.table, fk: { name: '', columns: [draft.column], refSchema: schema, refTable: draft.refTable, refColumns: [draft.refColumn], onUpdate: draft.onUpdate, onDelete: draft.onDelete } }] }))
              setDraft(null)
            }}>Add</button>
          </>}
        >
          <div className="mono selectable" style={{ fontSize: 'var(--fs-sm)' }}>{draft.table}.{draft.column} → {draft.refTable}.{draft.refColumn}</div>
          {(['onUpdate', 'onDelete'] as const).map((k) => (
            <div key={k} className="field">
              <label htmlFor={`dg-${k}`}>{k === 'onUpdate' ? 'On update' : 'On delete'}</label>
              <select id={`dg-${k}`} className="select" value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}>
                {FK_ACTIONS.map((a) => <option key={a}>{a}</option>)}
              </select>
            </div>
          ))}
          <div className="faint" style={{ fontSize: 'var(--fs-sm)' }}>The change is staged. Review it with Preview and apply it with Commit.</div>
        </Modal>
      )}
    </div>
  )
}
