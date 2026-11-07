// Feature tour: a spotlight walks through the main parts of the window. Targets are elements with data-tour="…";
// a step whose target isn't on screen shows its card in the middle with a hint.
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { call, useSettings } from '../lib/api'

interface Step { target?: string; title: string; body: ReactNode; missing?: string }

const k = (s: string): ReactNode => <span className="tour-kbd">{s}</span>

export const TOUR: Step[] = [
  { title: 'Welcome to Lagoon', body: <>A two-minute look at what Lagoon can do. Use {k('→')} and {k('←')} or the buttons; {k('Esc')} ends the tour. You can replay it any time from <b>Help ▸ Feature Tour</b>.</> },
  { target: 'tree', title: 'Every connection in one place', body: <>Connections, their databases, schemas and tables live in this tree. <b>Double-click</b> a connection to connect and a database to open it. Several connections and databases can be open at once.</> },
  { target: 'new-conn', title: 'Add a connection', body: <>PostgreSQL, MySQL, MariaDB, SQLite, Redis and MongoDB, with SSH tunnels, SSL and passwords kept in your system keychain. You can also paste a connection URL or import a shared file.</> },
  { target: 'tabs', title: 'Tabs from any database', body: <>Tables and queries open as tabs. Each tab is labelled with its database and keeps its own session, so tabs from different servers can sit side by side. {k('⌘1')}–{k('⌘9')} jump between them.</> },
  { target: 'record-bar', title: 'Edit right in the grid', body: <>Click a selected cell, press {k('Enter')} or just start typing to edit. The cell shows <b>✓</b> to keep the value and <b>✗</b> to cancel. Here you add {k('+')} or remove {k('−')} rows, then <b>✓ save</b> or <b>✗ discard</b> all changes. Nothing reaches the database until you save.</>, missing: 'Open a table to see the record bar.' },
  { target: 'pending', title: 'Review before saving', body: <>Every staged change is real SQL. Preview it ({k('⇧⌘P')}), commit it in one transaction ({k('⌘S')}) or throw it away ({k('⇧⌘⌫')}). Query results from a single table can be edited the same way.</> },
  { target: 'filters', title: 'Filter, find and save views', body: <>Unlimited filters with AND or OR, raw SQL conditions, find and replace across the page, and profiles that remember filters, sort and columns per table.</>, missing: 'Open a table to see filters, find and profiles.' },
  { target: 'new-query', title: 'The SQL editor', body: <>{k('⌘E')} opens an editor with autocomplete, snippets and one result tab per statement. {k('⌘↩')} runs the statement under the cursor; <b>Explain</b> draws the query plan and highlights slow steps.</> },
  { target: 'palette', title: 'Open anything', body: <>{k('⌘P')} jumps to any table, view, function, database, saved query or feature by typing a few letters.</> },
  { target: 'safe', title: 'Safe mode', body: <>Five levels per connection, from silent to "ask for the password before every write". Use it on production so nothing changes by accident.</> },
  { target: 'tools', title: 'Tools', body: <>Data transfer between connections, data and structure sync with migration scripts, test data, a data dictionary, import and export, backup and restore, the process list, users, the ER diagram, dashboards and plugins.</> },
  { target: 'panels', title: 'Console and details', body: <>The console shows every statement Lagoon sends. The details panel ({k('Space')}) edits the selected row as a form, even several rows at once.</> },
  { title: 'You are all set', body: <>Themes, fonts and every shortcut are in <b>Settings</b> ({k('⌘,')}). Have fun, and happy querying.</> }
]

export const useTour = create<{ open: boolean; step: number }>(() => ({ open: false, step: 0 }))
export const startTour = (): void => useTour.setState({ open: true, step: 0 })

const PAD = 6
const CARD_W = 340

export function Tour(): ReactNode {
  const { open, step } = useTour()
  // shows at startup until the user turns it off (checkbox in the card) or finishes every step
  const onStartup = useSettings((s) => s.s['tour.onStartup'] !== false && s.s['tour.done'] !== true)
  const loaded = useSettings((s) => s.loaded)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const card = useRef<HTMLDivElement>(null)
  const [cardPos, setCardPos] = useState({ x: 0, y: 0 })
  const s = TOUR[step]

  useEffect(() => {
    if (!loaded || !onStartup) return
    const t = setTimeout(() => { const st = useSettings.getState().s; if (st['tour.onStartup'] !== false && st['tour.done'] !== true) startTour() }, 900)
    return () => clearTimeout(t)
  }, [loaded])

  const setStartup = (v: boolean): void => { void call('settings.set', 'tour.onStartup', v); if (!v) void call('settings.set', 'tour.done', true); else void call('settings.set', 'tour.done', false) }
  const close = (): void => useTour.setState({ open: false })
  // finishing every step means it has been seen: stop showing it at startup
  const complete = (): void => { close(); setStartup(false) }
  const go = (d: number): void => { const n = step + d; if (n < 0) return; if (n >= TOUR.length) complete(); else useTour.setState({ step: n }) }

  // follow the target while the step is shown (layouts move, panels open)
  useEffect(() => {
    if (!open) return
    const measure = (): void => {
      const el = s.target ? document.querySelector<HTMLElement>(`[data-tour="${s.target}"]`) : null
      const r = el?.getBoundingClientRect()
      setRect(r && r.width > 0 && r.height > 0 ? r : null)
    }
    measure()
    const id = setInterval(measure, 400)
    window.addEventListener('resize', measure)
    return () => { clearInterval(id); window.removeEventListener('resize', measure) }
  }, [open, step])

  useLayoutEffect(() => {
    if (!open || !card.current) return
    const h = card.current.offsetHeight
    if (!rect) { setCardPos({ x: (innerWidth - CARD_W) / 2, y: (innerHeight - h) / 2 }); return }
    const gap = 14
    const fits = { right: rect.right + gap + CARD_W < innerWidth - 8, left: rect.left - gap - CARD_W > 8, below: rect.bottom + gap + h < innerHeight - 8 }
    let x: number, y: number
    if (fits.right && rect.width < innerWidth / 2) { x = rect.right + gap; y = rect.top }
    else if (fits.left && rect.width < innerWidth / 2) { x = rect.left - gap - CARD_W; y = rect.top }
    else if (fits.below) { x = rect.left; y = rect.bottom + gap }
    else { x = rect.left; y = rect.top - gap - h }
    setCardPos({ x: Math.max(8, Math.min(x, innerWidth - CARD_W - 8)), y: Math.max(8, Math.min(y, innerHeight - h - 8)) })
  }, [rect, step, open])

  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(1) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(-1) }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [open, step])

  useEffect(() => { if (open) card.current?.querySelector<HTMLButtonElement>('.tour-next')?.focus() }, [open, step])

  if (!open) return null
  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      {rect ? (
        <div className="tour-hole" style={{ left: rect.left - PAD, top: rect.top - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }} />
      ) : (
        <div className="tour-dim" />
      )}
      <div ref={card} className="tour-card" style={{ left: cardPos.x, top: cardPos.y, width: CARD_W }}>
        <div className="tour-step">{step + 1} of {TOUR.length}</div>
        <div id="tour-title" className="tour-title">{s.title}</div>
        <div className="tour-body">{s.body}</div>
        {s.target && !rect && s.missing && <div className="tour-missing">{s.missing}</div>}
        <div className="tour-dots" aria-hidden>{TOUR.map((_, i) => <span key={i} className={i === step ? 'on' : i < step ? 'past' : ''} />)}</div>
        <label className="check tour-startup">
          <input type="checkbox" checked={onStartup} onChange={(e) => setStartup(e.target.checked)} /> Show this tour when Lagoon opens
        </label>
        <div className="tour-actions">
          {step < TOUR.length - 1 && <button className="btn ghost sm" onClick={close}>Skip tour</button>}
          <span className="grow" />
          {step > 0 && <button className="btn sm" onClick={() => go(-1)}>Back</button>}
          <button className="btn primary sm tour-next" onClick={() => go(1)}>{step === TOUR.length - 1 ? 'Start using Lagoon' : step === 0 ? 'Show me' : 'Next'}</button>
        </div>
      </div>
    </div>
  )
}
