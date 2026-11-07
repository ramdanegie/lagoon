// Metrics board: a canvas of query-driven tables, scoreboards, charts and form controls wired by $variables.
import { type ReactNode, type MouseEvent as RME, useEffect, useRef, useState } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { sql, MySQL, PostgreSQL, SQLite } from '@codemirror/lang-sql'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import type { Result } from '@shared/types'
import { applyParams, splitStatements } from '@shared/split'
import { call, errText, fail, toast, uid } from '../lib/api'
import { runSql, ws, type Tab } from '../lib/ws'
import { csvSettings, formatRows, toCsv } from '../lib/format'
import {
  type Board, type BoardObject, type BoardRow, type ObjType, OBJ_LABELS, REFRESH_CHOICES, cellText, isControl, isData, latestBoard, newObject, parseBoardFile, snap
} from '../lib/metrics'
import { Grid } from '../components/Grid'
import { Chart } from '../components/Chart'
import { Icon } from '../components/Icon'
import { Modal, confirmDialog, menuAt, menuBelow, promptDialog, type MenuItem } from '../components/ui'
import '../styles/metrics.css'

interface ObjState { result?: Result; error?: string; loading?: boolean }
const ADD_ORDER: ObjType[] = ['table', 'scoreboard', 'bar', 'line', 'pie', 'input', 'dropdown', 'button', 'exporter']
const norm = (b?: Partial<Board> | null): Board => ({ objects: b?.objects ?? [], links: b?.links ?? [], locked: !!b?.locked, grid: b?.grid !== false, updatedAt: b?.updatedAt })
const colIndex = (r: Result, name: string | undefined, fallback: number): number => (name ? r.columns.findIndex((c) => c.name === name) : fallback)

export function MetricsBoard({ tab }: { tab: Tab }): ReactNode {
  const [boards, setBoards] = useState<BoardRow[]>([])
  const [curId, setCurId] = useState<string>()
  const [board, setBoardState] = useState<Board | null>(null)
  const [res, setRes] = useState<Record<string, ObjState>>({})
  const [options, setOptions] = useState<Record<string, string[]>>({})
  const [running, setRunning] = useState(true)
  const [editing, setEditing] = useState<string | null>(null)
  const [linkDrag, setLinkDrag] = useState<{ from: string; x: number; y: number } | null>(null)
  const [loadKey, setLoadKey] = useState(0)

  const boardRef = useRef<Board | null>(null)
  const curRef = useRef<BoardRow | undefined>(undefined)
  const resRef = useRef(res)
  resRef.current = res
  const vars = useRef<Record<string, string>>({})
  const drafts = useRef<Record<string, string>>({})
  const lastRun = useRef<Record<string, number>>({})
  const inflight = useRef(new Set<string>())
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const inner = useRef<HTMLDivElement>(null)
  const curRow = boards.find((b) => b.id === curId)
  curRef.current = curRow

  // ---------- persistence ----------
  const persist = async (): Promise<void> => {
    const row = curRef.current
    const b = boardRef.current
    if (!row || !b) return
    try { setBoards(await call<BoardRow[]>('metrics.save', { id: row.id, name: row.name, connectionId: row.connectionId, board: { ...b, updatedAt: Date.now() } })) } catch (e) { fail(e) }
  }
  const flush = (): void => {
    if (!saveTimer.current) return
    clearTimeout(saveTimer.current)
    saveTimer.current = undefined
    void persist()
  }
  const update = (fn: (b: Board) => Board): void => {
    if (!boardRef.current) return
    const nb = fn(boardRef.current)
    boardRef.current = nb
    setBoardState(nb)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { saveTimer.current = undefined; void persist() }, 400)
  }
  const patchObj = (id: string, p: Partial<BoardObject>): void => update((b) => ({ ...b, objects: b.objects.map((o) => (o.id === id ? { ...o, ...p } : o)) }))

  const select = (row: BoardRow | undefined): void => {
    flush()
    curRef.current = row
    setCurId(row?.id)
    boardRef.current = row ? norm(row.board) : null
    setBoardState(boardRef.current)
    setRes({})
    setOptions({})
    lastRun.current = {}
    drafts.current = {}
    setLoadKey((k) => k + 1)
  }

  const reloadList = async (pick?: string): Promise<void> => {
    let list = await call<BoardRow[]>('metrics.list')
    if (!list.length) list = await call<BoardRow[]>('metrics.save', { id: uid(), name: 'Board 1', board: { objects: [], links: [], grid: true, updatedAt: Date.now() } })
    setBoards(list)
    select(list.find((b) => b.id === pick) ?? latestBoard(list))
  }

  useEffect(() => {
    reloadList().catch(fail)
    const onChanged = (): void => { flush(); reloadList().catch(fail) }
    window.addEventListener('metrics:changed', onChanged)
    return () => { window.removeEventListener('metrics:changed', onChanged); flush() }
  }, [])

  // ---------- running queries ----------
  const subst = (q: string): string => applyParams(q, 'dollar', vars.current, true)

  const query = async (q: string): Promise<ObjState> => {
    try {
      const stmts = splitStatements(subst(q), ws().dialect).map((s) => s.sql)
      const out = await runSql(stmts, { source: 'metrics', stopOnError: true })
      if (!out) return { error: 'Cancelled by safe mode.' }
      const failed = out.find((r) => r.error)
      return failed ? { error: failed.error } : { result: out[out.length - 1] }
    } catch (e) {
      return { error: errText(e) }
    }
  }

  const run = async (o: BoardObject): Promise<void> => {
    if (!o.query?.trim() || inflight.current.has(o.id)) return
    inflight.current.add(o.id)
    lastRun.current[o.id] = Date.now()
    setRes((r) => ({ ...r, [o.id]: { ...r[o.id], loading: true } }))
    const next = await query(o.query)
    inflight.current.delete(o.id)
    setRes((r) => ({ ...r, [o.id]: next }))
  }

  const loadOptions = async (o: BoardObject): Promise<void> => {
    if (!o.optionsQuery?.trim()) return
    const r = await query(o.optionsQuery)
    if (r.error) toast(`${o.label}: ${r.error}`, 'error')
    else setOptions((m) => ({ ...m, [o.id]: (r.result?.rows ?? []).map((row) => cellText(row[0])) }))
  }

  const refreshAll = (): void => {
    for (const o of boardRef.current?.objects ?? []) {
      if (isData(o.type)) void run(o)
      if (o.type === 'dropdown') void loadOptions(o)
    }
  }

  // first load of a board: everything except "On event" objects
  useEffect(() => {
    const b = boardRef.current
    if (!b) return
    vars.current = Object.fromEntries(b.objects.filter((o) => o.varName).map((o) => [o.varName!, o.value ?? '']))
    for (const o of b.objects) {
      if (isData(o.type) && o.refresh !== 'event') void run(o)
      if (o.type === 'dropdown') void loadOptions(o)
    }
  }, [loadKey])

  // one ticker drives every interval refresh
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => {
      const now = Date.now()
      for (const o of boardRef.current?.objects ?? []) {
        if (isData(o.type) && typeof o.refresh === 'number' && now - (lastRun.current[o.id] ?? 0) >= o.refresh * 1000) void run(o)
      }
    }, 1000)
    return () => clearInterval(t)
  }, [running])

  // ---------- wiring ----------
  const fire = (fromId: string, seen = new Set<string>()): void => {
    seen.add(fromId)
    const b = boardRef.current!
    for (const l of b.links) {
      if (l.from !== fromId || seen.has(l.to)) continue
      const t = b.objects.find((x) => x.id === l.to)
      if (!t) continue
      seen.add(t.id)
      if (isData(t.type)) void run(t)
      else if (t.type === 'exporter') void exportFrom(t)
      else if (t.type === 'button') fire(t.id, seen)
      else {
        if (t.type === 'dropdown') void loadOptions(t)
        if (t.submit === 'event') submit(t, drafts.current[t.id] ?? t.value ?? '', seen)
      }
    }
  }

  const submit = (o: BoardObject, value: string, seen?: Set<string>): void => {
    if (o.varName) vars.current[o.varName] = value
    if (o.value !== value) patchObj(o.id, { value })
    fire(o.id, seen)
  }

  const exportFrom = async (o: BoardObject): Promise<void> => {
    const b = boardRef.current!
    const src = b.links.map((l) => (l.from === o.id ? l.to : l.to === o.id ? l.from : '')).map((id) => b.objects.find((x) => x.id === id)).find((x) => x && isData(x.type))
    if (!src) return toast('Connect the exporter to a data object first: drag from its dot onto a table or chart.')
    const r = resRef.current[src.id]?.result
    if (!r) return toast(`${src.label} has no result to export yet.`)
    const fmt = o.format ?? 'csv'
    const path = await call<string | undefined>('dialog.save', { defaultPath: `${src.label || 'result'}.${fmt}`, filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }] })
    if (!path) return
    const cols = r.columns.map((c) => c.name)
    try {
      await call('file.write', path, fmt === 'json' ? formatRows('json', cols, r.rows) : toCsv(cols, r.rows, { ...csvSettings(), header: true }))
      toast(`Exported ${r.rows.length} rows`, 'success')
    } catch (e) { fail(e) }
  }

  // ---------- board list ----------
  const saveRow = async (row: Partial<BoardRow> & { name: string; board: Board }): Promise<string> => {
    const id = row.id ?? uid()
    setBoards(await call<BoardRow[]>('metrics.save', { ...row, id, board: { ...row.board, updatedAt: Date.now() } }))
    return id
  }
  const boardOf = (b: BoardRow): Board => (b.id === curId && boardRef.current ? boardRef.current : norm(b.board))
  const newBoard = async (): Promise<void> => {
    const names = new Set(boards.map((b) => b.name))
    let n = boards.length + 1
    while (names.has(`Board ${n}`)) n++
    const id = await saveRow({ name: `Board ${n}`, board: norm({ grid: true }) })
    select({ id, name: `Board ${n}`, connectionId: null, board: norm({ grid: true }) })
  }
  const importBoard = async (): Promise<void> => {
    const [f] = await call<string[]>('dialog.open', { properties: ['openFile'], filters: [{ name: 'Metrics board', extensions: ['json'] }] })
    if (!f) return
    try {
      const { name, board: b } = parseBoardFile(await call<string>('file.read', f))
      const id = await saveRow({ name, board: b })
      select({ id, name, connectionId: null, board: b })
    } catch (e) { fail(e) }
  }
  const listMenu = (b?: BoardRow): MenuItem[] => [
    { label: 'New board', onClick: () => void newBoard().catch(fail) },
    ...(b ? [
      { label: 'Rename…', onClick: async () => { const n = (await promptDialog('Rename board', b.name))?.trim(); if (n) await saveRow({ ...b, name: n, board: boardOf(b) }).catch(fail) } },
      { label: 'Duplicate', onClick: () => void saveRow({ name: `${b.name} copy`, connectionId: b.connectionId, board: structuredClone(boardOf(b)) }).catch(fail) },
      { label: 'Export board…', onClick: async () => {
        const path = await call<string | undefined>('dialog.save', { defaultPath: `${b.name}.json`, filters: [{ name: 'Metrics board', extensions: ['json'] }] })
        if (path) await call('file.write', path, JSON.stringify({ format: 'lagoon-metrics-board', version: 1, name: b.name, board: { ...boardOf(b), updatedAt: undefined } }, null, 2)).then(() => toast('Board exported', 'success'), fail)
      } }
    ] : []),
    { label: 'Import board…', onClick: () => void importBoard() },
    ...(b ? [{ sep: true }, { label: 'Delete…', danger: true, onClick: async () => {
      if (!(await confirmDialog(`Delete "${b.name}"?`, 'The board and all of its objects are removed.', { ok: 'Delete', danger: true }))) return
      if (b.id === curId) { clearTimeout(saveTimer.current); saveTimer.current = undefined }
      await call('metrics.delete', b.id)
      await reloadList(b.id === curId ? undefined : curId)
    } }] : [])
  ]

  // ---------- canvas interactions ----------
  const locked = !!board?.locked
  const point = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = inner.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const addObject = (type: ObjType, at?: { x: number; y: number }): void => {
    const o = newObject(type, uid(), boardRef.current!.objects, at)
    update((b) => ({ ...b, objects: [...b.objects, o] }))
    if (isData(type) || type === 'dropdown' || type === 'input') setEditing(o.id)
  }
  const addItems = (at?: { x: number; y: number }): MenuItem[] =>
    ADD_ORDER.flatMap((t) => [...(t === 'input' || t === 'exporter' ? [{ sep: true }] : []), { label: OBJ_LABELS[t], onClick: () => addObject(t, at) }])
  const removeObj = (id: string): void => update((b) => ({ ...b, objects: b.objects.filter((o) => o.id !== id), links: b.links.filter((l) => l.from !== id && l.to !== id) }))
  const duplicate = (o: BoardObject): void => update((b) => ({ ...b, objects: [...b.objects, { ...structuredClone(o), id: uid(), frame: { ...o.frame, x: o.frame.x + 24, y: o.frame.y + 24 } }] }))

  /** Drag helper: reports the pointer delta from the mousedown point until mouseup. */
  const dragFrom = (e: RME, move: (dx: number, dy: number, ev: MouseEvent) => void, up?: (ev: MouseEvent) => void): void => {
    e.preventDefault()
    e.stopPropagation()
    const sx = e.clientX
    const sy = e.clientY
    const mm = (ev: MouseEvent): void => move(ev.clientX - sx, ev.clientY - sy, ev)
    const mu = (ev: MouseEvent): void => { window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', mu); up?.(ev) }
    window.addEventListener('mousemove', mm)
    window.addEventListener('mouseup', mu)
  }
  const startMove = (e: RME, o: BoardObject): void => {
    if (e.button !== 0 || locked || (e.target as HTMLElement).closest('input, select, button, textarea, .grid, .mb-dot, .mb-resize, .recharts-wrapper')) return
    ;(e.currentTarget as HTMLElement).focus()
    const f = o.frame
    dragFrom(e, (dx, dy) => patchObj(o.id, { frame: { ...f, x: snap(f.x + dx), y: snap(f.y + dy) } }))
  }
  const startResize = (e: RME, o: BoardObject): void => {
    const f = o.frame
    dragFrom(e, (dx, dy) => patchObj(o.id, { frame: { ...f, w: Math.max(128, snap(f.w + dx)), h: Math.max(56, snap(f.h + dy)) } }))
  }
  const startLink = (e: RME, o: BoardObject): void => {
    const p = point(e)
    setLinkDrag({ from: o.id, ...p })
    dragFrom(e, (_dx, _dy, ev) => setLinkDrag({ from: o.id, ...point(ev) }), (ev) => {
      setLinkDrag(null)
      const to = (document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-obj]') as HTMLElement | null)?.dataset.obj
      if (to && to !== o.id) update((b) => (b.links.some((l) => l.from === o.id && l.to === to) ? b : { ...b, links: [...b.links, { from: o.id, to }] }))
    })
  }

  const objMenu = (o: BoardObject): MenuItem[] => [
    { label: 'Settings…', disabled: locked, onClick: () => setEditing(o.id) },
    { label: 'Refresh', disabled: !isData(o.type) && o.type !== 'dropdown', onClick: () => (o.type === 'dropdown' ? void loadOptions(o) : void run(o)) },
    { label: 'Duplicate', disabled: locked, onClick: () => duplicate(o) },
    { label: 'Disconnect links', disabled: locked || !board?.links.some((l) => l.from === o.id || l.to === o.id), onClick: () => update((b) => ({ ...b, links: b.links.filter((l) => l.from !== o.id && l.to !== o.id) })) },
    { sep: true },
    { label: 'Delete', danger: true, disabled: locked, onClick: () => removeObj(o.id) }
  ]

  const objKey = (e: React.KeyboardEvent, o: BoardObject): void => {
    if (e.target !== e.currentTarget) return
    const step = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] }[e.key]
    if (e.key === 'Enter' && !locked) setEditing(o.id)
    else if ((e.key === 'Delete' || e.key === 'Backspace') && !locked) removeObj(o.id)
    else if (step && !locked) { e.preventDefault(); patchObj(o.id, { frame: { ...o.frame, x: snap(o.frame.x + step[0]), y: snap(o.frame.y + step[1]) } }) }
  }

  // ---------- rendering ----------
  const body = (o: BoardObject): ReactNode => {
    const st = res[o.id] ?? {}
    if (o.type === 'input') return <InputObj o={o} onDraft={(v) => (drafts.current[o.id] = v)} onSubmit={(v) => submit(o, v)} />
    if (o.type === 'dropdown') {
      const list = o.optionsQuery?.trim() ? options[o.id] ?? [] : (o.options ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      return <DropdownObj o={o} list={list} onDraft={(v) => (drafts.current[o.id] = v)} onSubmit={(v) => submit(o, v)} />
    }
    if (o.type === 'button') return <button className="btn primary mb-button" onClick={() => fire(o.id)}>{o.label || 'Run'}</button>
    if (o.type === 'exporter') return <button className="btn mb-button" onClick={() => void exportFrom(o)}><Icon name="download" size={12} />Export {(o.format ?? 'csv').toUpperCase()}…</button>
    if (st.error) return <div className="mb-error selectable" role="alert">{st.error}</div>
    if (!o.query?.trim()) return <div className="empty">No query yet<button className="btn sm" disabled={locked} onClick={() => setEditing(o.id)}>Open settings</button></div>
    const r = st.result
    if (!r) return o.refresh === 'event' && !st.loading ? <div className="empty">Waits for a linked control</div> : null
    if (o.type === 'table') return <><Grid columns={r.columns.map((c) => ({ name: c.name, type: c.type }))} rows={r.rows} /><div className="mb-foot faint">{r.rows.length} rows · {r.ms} ms</div></>
    if (o.type === 'scoreboard') {
      const row = r.rows[0]
      const si = colIndex(r, o.score, 0)
      const di = colIndex(r, o.detail, 1)
      const score = row?.[si]
      return (
        <div className="mb-score">
          <div className="mb-score-value mono">{row ? (typeof score === 'number' || /^-?\d+(\.\d+)?$/.test(String(score)) ? Number(score).toLocaleString() : cellText(score)) : '—'}</div>
          {row && di >= 0 && di < r.columns.length && <div className="mb-score-detail muted ellipsis">{cellText(row[di])}</div>}
        </div>
      )
    }
    return <Chart type={o.type as 'bar' | 'line' | 'pie'} columns={r.columns} rows={r.rows} x={o.x} y={o.y} />
  }

  const linkPath = (a: BoardObject['frame'], bx: number, by: number): string => {
    const ax = a.x + a.w
    const ay = a.y + a.h / 2
    const c = Math.max(40, Math.abs(bx - ax) / 2)
    return `M${ax},${ay} C${ax + c},${ay} ${bx - c},${by} ${bx},${by}`
  }

  const objects = board?.objects ?? []
  const width = Math.max(0, ...objects.map((o) => o.frame.x + o.frame.w)) + 240
  const height = Math.max(0, ...objects.map((o) => o.frame.y + o.frame.h)) + 240
  const editObj = objects.find((o) => o.id === editing)

  return (
    <div className="mb">
      <div className="mb-list" role="listbox" aria-label="Metrics boards" onContextMenu={(e) => menuAt(e, listMenu())}>
        <div className="section-title">Boards<span className="grow" /><button className="btn ghost icon sm" title="New board" aria-label="New board" onClick={() => void newBoard().catch(fail)}><Icon name="plus" size={12} /></button></div>
        {boards.map((b) => (
          <div
            key={b.id}
            role="option"
            aria-selected={b.id === curId}
            tabIndex={0}
            className={`list-item ${b.id === curId ? 'selected' : ''}`}
            onClick={() => b.id !== curId && select(b)}
            onKeyDown={(e) => e.key === 'Enter' && b.id !== curId && select(b)}
            onContextMenu={(e) => menuAt(e, listMenu(b))}
          >
            <Icon name="chart" size={12} /><span className="ellipsis">{b.name}</span>
            <span className="count">{(b.id === curId ? objects : b.board?.objects ?? []).length}</span>
          </div>
        ))}
      </div>
      <div className="mb-main">
        <div className="runbar" role="toolbar" aria-label={`${tab.title} board`}>
          <button className="btn sm" aria-pressed={running} title={running ? 'Stop auto refresh' : 'Start auto refresh'} onClick={() => setRunning(!running)}>
            <Icon name={running ? 'stop' : 'play'} size={10} />{running ? 'Stop' : 'Run'}
          </button>
          <button className="btn sm" disabled={!board || locked} onClick={(e) => menuBelow(e.currentTarget, addItems())}><Icon name="plus" size={11} />Add<Icon name="chevronDown" size={10} /></button>
          <button className={`btn sm ${locked ? 'on' : ''}`} aria-pressed={locked} disabled={!board} title="Prevent moving, resizing and editing objects" onClick={() => update((b) => ({ ...b, locked: !b.locked }))}><Icon name={locked ? 'lock' : 'unlock'} size={11} />Lock</button>
          <button className={`btn sm ${board?.grid ? 'on' : ''}`} aria-pressed={!!board?.grid} disabled={!board} title="Show the grid and connector lines" onClick={() => update((b) => ({ ...b, grid: !b.grid }))}><Icon name="columns" size={11} />Grid</button>
          <button className="btn sm" disabled={!board} onClick={refreshAll}><Icon name="refresh" size={11} />Refresh all</button>
          <span className="grow" />
          <span className="faint ellipsis" style={{ fontSize: 'var(--fs-sm)' }}>{curRow?.name}{running ? '' : ' · auto refresh stopped'}</span>
        </div>
        <div className={`mb-canvas ${board?.grid ? 'grid-on' : ''}`} onContextMenu={(e) => !locked && board && menuAt(e, [{ header: 'Add' }, ...addItems(point(e))])}>
          <div ref={inner} className="mb-inner" style={{ width, height }}>
            {objects.map((o) => {
              const st = res[o.id] ?? {}
              return (
                <div
                  key={o.id}
                  data-obj={o.id}
                  className={`mb-obj type-${o.type} ${locked ? 'locked' : ''}`}
                  style={{ left: o.frame.x, top: o.frame.y, width: o.frame.w, height: o.frame.h }}
                  tabIndex={0}
                  role="group"
                  aria-label={`${OBJ_LABELS[o.type]}: ${o.label}`}
                  onMouseDown={(e) => startMove(e, o)}
                  onContextMenu={(e) => menuAt(e, objMenu(o))}
                  onKeyDown={(e) => objKey(e, o)}
                >
                  <div className="mb-head" onDoubleClick={() => !locked && setEditing(o.id)}>
                    <span className="ellipsis">{o.type === 'button' ? OBJ_LABELS.button : o.label}</span>
                    <span className="grow" />
                    {isData(o.type) && <button className="btn ghost icon sm" title="Refresh" aria-label={`Refresh ${o.label}`} onClick={() => void run(o)}><Icon name="refresh" size={11} /></button>}
                    {!locked && <button className="btn ghost icon sm" title="Settings" aria-label={`Settings for ${o.label}`} onClick={() => setEditing(o.id)}><Icon name="gear" size={11} /></button>}
                  </div>
                  {st.loading && <span className="mb-progress" aria-label="Loading" />}
                  <div className="mb-body">{body(o)}</div>
                  {(isControl(o.type) || o.type === 'exporter') && !locked && (
                    <span className="mb-dot" title="Drag onto an object to connect" aria-hidden onMouseDown={(e) => startLink(e, o)} />
                  )}
                  {!locked && <span className="mb-resize" aria-hidden onMouseDown={(e) => startResize(e, o)} />}
                </div>
              )
            })}
            <svg className="mb-links" width={width} height={height} aria-hidden>
              {board?.grid && board.links.map((l, i) => {
                const a = objects.find((o) => o.id === l.from)
                const b = objects.find((o) => o.id === l.to)
                if (!a || !b) return null
                const d = linkPath(a.frame, b.frame.x, b.frame.y + b.frame.h / 2)
                const menu = (e: RME): void => menuAt(e, [{ label: 'Delete link', danger: true, disabled: locked, onClick: () => update((bd) => ({ ...bd, links: bd.links.filter((x) => x !== l) })) }])
                return (
                  <g key={i}>
                    <path d={d} className="mb-link" />
                    <path d={d} className="mb-link-hit" onClick={menu} onContextMenu={menu} />
                  </g>
                )
              })}
              {linkDrag && (() => { const a = objects.find((o) => o.id === linkDrag.from); return a ? <path d={linkPath(a.frame, linkDrag.x, linkDrag.y)} className="mb-link drafting" /> : null })()}
            </svg>
            {board && !objects.length && (
              <div className="empty mb-empty">
                <Icon name="chart" size={32} />
                <div>This board is empty</div>
                <button className="btn" disabled={locked} onClick={(e) => menuBelow(e.currentTarget, addItems())}>Add an object</button>
              </div>
            )}
          </div>
        </div>
      </div>
      {editObj && (
        <SettingsModal
          o={editObj}
          columns={res[editObj.id]?.result?.columns.map((c) => c.name) ?? []}
          test={query}
          onClose={() => setEditing(null)}
          onSave={(p) => {
            setEditing(null)
            patchObj(editObj.id, p)
            const next = { ...editObj, ...p }
            if (p.varName && p.varName !== editObj.varName) vars.current[p.varName] = next.value ?? ''
            if (isData(next.type) && next.refresh !== 'event') void run(next)
            if (next.type === 'dropdown') void loadOptions(next)
          }}
        />
      )}
    </div>
  )
}

// ---------- controls ----------
function InputObj({ o, onDraft, onSubmit }: { o: BoardObject; onDraft: (v: string) => void; onSubmit: (v: string) => void }): ReactNode {
  const [v, setV] = useState(o.value ?? '')
  return (
    <input
      className="input mb-control"
      aria-label={o.label}
      placeholder={`$${o.varName ?? 'input'}`}
      value={v}
      onChange={(e) => { setV(e.target.value); onDraft(e.target.value) }}
      onKeyDown={(e) => e.key === 'Enter' && o.submit === 'enter' && onSubmit(v)}
      onBlur={() => o.submit === 'blur' && onSubmit(v)}
    />
  )
}

function DropdownObj({ o, list, onDraft, onSubmit }: { o: BoardObject; list: string[]; onDraft: (v: string) => void; onSubmit: (v: string) => void }): ReactNode {
  const [v, setV] = useState(o.value ?? '')
  return (
    <select
      className="select mb-control"
      aria-label={o.label}
      value={v}
      onChange={(e) => { setV(e.target.value); onDraft(e.target.value); if (o.submit !== 'event') onSubmit(e.target.value) }}
    >
      <option value="">Choose…</option>
      {v && !list.includes(v) && <option value={v}>{v}</option>}
      {list.map((x, i) => <option key={i} value={x}>{x}</option>)}
    </select>
  )
}

// ---------- settings ----------
const hl = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syn-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syn-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syn-number)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [tags.name, tags.special(tags.name)], color: 'var(--syn-ident)' }
])

function SqlField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const cb = useRef(onChange)
  cb.current = onChange
  useEffect(() => {
    const d = ws().dialect
    const view = new EditorView({
      doc: value,
      parent: host.current!,
      extensions: [
        basicSetup,
        sql({ dialect: d === 'mysql' ? MySQL : d === 'sqlite' ? SQLite : PostgreSQL }),
        syntaxHighlighting(hl),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': label }),
        EditorView.updateListener.of((u) => { if (u.docChanged) cb.current(u.state.doc.toString()) })
      ]
    })
    return () => view.destroy()
  }, [])
  return <div ref={host} className="editor-wrap mb-sql" />
}

function SettingsModal({ o, columns, test, onClose, onSave }: {
  o: BoardObject
  columns: string[]
  test: (q: string) => Promise<ObjState>
  onClose: () => void
  onSave: (p: Partial<BoardObject>) => void
}): ReactNode {
  const [d, setD] = useState<BoardObject>(o)
  const [cols, setCols] = useState(columns)
  const [testMsg, setTestMsg] = useState<{ text: string; error?: boolean } | null>(null)
  const set = (p: Partial<BoardObject>): void => setD((x) => ({ ...x, ...p }))
  const listId = `mb-cols-${o.id}`
  const runTest = async (q: string): Promise<void> => {
    setTestMsg({ text: 'Running…' })
    const r = await test(q)
    const names = r.result?.columns.map((c) => c.name) ?? []
    if (r.result) { setCols(names); setTestMsg({ text: `${r.result.rows.length} rows · columns: ${names.join(', ') || 'none'}` }) } else setTestMsg({ text: r.error ?? 'No result', error: true })
  }
  const colField = (id: string, label: string, key: 'x' | 'score' | 'detail', hint: string): ReactNode => (
    <div className="field"><label htmlFor={id}>{label}</label><input id={id} className="input" list={listId} placeholder={hint} value={d[key] ?? ''} onChange={(e) => set({ [key]: e.target.value || undefined })} /></div>
  )
  const ys = d.y ?? []
  const toggleY = (c: string): void => set({ y: ys.includes(c) ? ys.filter((x) => x !== c) : [...ys, c] })
  const valid = !(d.type === 'input' || d.type === 'dropdown') || /^[A-Za-z_]\w*$/.test(d.varName ?? '')

  return (
    <Modal
      title={`${OBJ_LABELS[o.type]} settings`}
      width={isData(o.type) || o.type === 'dropdown' ? 620 : 420}
      onClose={onClose}
      footer={<>
        {(isData(d.type) || (d.type === 'dropdown' && d.optionsQuery !== undefined)) && <button className="btn" style={{ marginRight: 'auto' }} onClick={() => void runTest((isData(d.type) ? d.query : d.optionsQuery) ?? '')}>Test query</button>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!valid} onClick={() => onSave({ ...d, label: d.label.trim() || OBJ_LABELS[d.type], y: d.y?.filter(Boolean) })}>Save</button>
      </>}
    >
      <datalist id={listId}>{cols.map((c) => <option key={c} value={c} />)}</datalist>
      <div className="field"><label htmlFor="mb-label">{d.type === 'button' ? 'Button text' : 'Label'}</label><input id="mb-label" className="input" autoFocus value={d.label} onChange={(e) => set({ label: e.target.value })} /></div>

      {isData(d.type) && <>
        <div className="mb-field-col"><span className="muted">Query <span className="faint">· use $name for values from linked controls</span></span><SqlField label="Query" value={d.query ?? ''} onChange={(q) => set({ query: q })} /></div>
        {(d.type === 'bar' || d.type === 'line') && <>
          {colField('mb-x', 'X axis', 'x', 'first column')}
          <div className="field">
            <label htmlFor="mb-y">Y axis</label>
            <div className="col" style={{ gap: 'var(--sp-2)' }}>
              <input id="mb-y" className="input" placeholder="numeric columns (comma separated)" value={ys.join(', ')} onChange={(e) => set({ y: e.target.value.split(',').map((s) => s.trim()) })} />
              {cols.length > 0 && <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--sp-2)' }}>{cols.map((c) => <button key={c} className={`btn sm ${ys.includes(c) ? 'on' : ''}`} aria-pressed={ys.includes(c)} onClick={() => toggleY(c)}>{c}</button>)}</div>}
            </div>
          </div>
        </>}
        {d.type === 'pie' && <>
          {colField('mb-x', 'Label column', 'x', 'first column')}
          <div className="field"><label htmlFor="mb-v">Value column</label><input id="mb-v" className="input" list={listId} placeholder="first numeric column" value={ys[0] ?? ''} onChange={(e) => set({ y: e.target.value ? [e.target.value] : undefined })} /></div>
        </>}
        {d.type === 'scoreboard' && <>
          {colField('mb-score', 'Score column', 'score', 'first column')}
          {colField('mb-detail', 'Detail column', 'detail', 'second column')}
        </>}
        <div className="field">
          <label htmlFor="mb-refresh">Refresh</label>
          <select id="mb-refresh" className="select" value={String(d.refresh ?? 'manual')} onChange={(e) => set({ refresh: /^\d+$/.test(e.target.value) ? Number(e.target.value) : (e.target.value as 'event' | 'manual') })}>
            {REFRESH_CHOICES.map((c) => <option key={String(c.value)} value={String(c.value)}>{c.label}</option>)}
          </select>
        </div>
      </>}

      {(d.type === 'input' || d.type === 'dropdown') && <>
        <div className="field">
          <label htmlFor="mb-var">Variable name</label>
          <input id="mb-var" className="input mono" value={d.varName ?? ''} aria-invalid={!valid} onChange={(e) => set({ varName: e.target.value.replace(/^\$/, '') })} />
        </div>
        <div className="field">
          <label htmlFor="mb-submit">Submit</label>
          <select id="mb-submit" className="select" value={d.submit} onChange={(e) => set({ submit: e.target.value as BoardObject['submit'] })}>
            {d.type === 'input' ? <><option value="enter">On Enter</option><option value="blur">When editing ends</option></> : <option value="change">When the value changes</option>}
            <option value="event">On event from a linked control</option>
          </select>
        </div>
        <div className="faint" style={{ fontSize: 'var(--fs-sm)' }}>Linked objects reload with <span className="mono">${d.varName || 'name'}</span> replaced by the value as typed. Add quotes in your SQL for text values.</div>
      </>}

      {d.type === 'dropdown' && <>
        <div className="field">
          <span className="muted" style={{ textAlign: 'right', fontSize: 'var(--fs-sm)' }}>Options</span>
          <div className="row">
            <label className="check"><input type="radio" name="mb-opt" checked={d.optionsQuery === undefined} onChange={() => set({ optionsQuery: undefined })} />Fixed list</label>
            <label className="check"><input type="radio" name="mb-opt" checked={d.optionsQuery !== undefined} onChange={() => set({ optionsQuery: d.optionsQuery ?? '' })} />From a query</label>
          </div>
        </div>
        {d.optionsQuery === undefined
          ? <div className="field"><label htmlFor="mb-opts">Values</label><input id="mb-opts" className="input" placeholder="draft, paid, shipped" value={d.options ?? ''} onChange={(e) => set({ options: e.target.value })} /></div>
          : <div className="mb-field-col"><span className="muted">Options query <span className="faint">· first column becomes the list</span></span><SqlField label="Options query" value={d.optionsQuery} onChange={(q) => set({ optionsQuery: q })} /></div>}
      </>}

      {d.type === 'exporter' && <>
        <div className="field">
          <label htmlFor="mb-fmt">Format</label>
          <select id="mb-fmt" className="select" value={d.format ?? 'csv'} onChange={(e) => set({ format: e.target.value as 'csv' | 'json' })}><option value="csv">CSV</option><option value="json">JSON</option></select>
        </div>
        <div className="faint" style={{ fontSize: 'var(--fs-sm)' }}>Drag from the exporter&apos;s dot onto a table or chart to choose what it exports.</div>
      </>}
      {d.type === 'button' && <div className="faint" style={{ fontSize: 'var(--fs-sm)' }}>Drag from the button&apos;s dot onto objects; clicking it reloads them.</div>}
      {testMsg && <div className={`mono selectable ${testMsg.error ? 'danger-text' : 'muted'}`} role="status" style={{ fontSize: 'var(--fs-sm)', whiteSpace: 'pre-wrap' }}>{testMsg.text}</div>}
    </Modal>
  )
}
