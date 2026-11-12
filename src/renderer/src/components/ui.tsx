import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { useToasts } from '../lib/api'

// ---------- Modal ----------
export function Modal(props: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number; className?: string }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const first = ref.current?.querySelector<HTMLElement>('[autofocus], input, select, textarea, button')
    first?.focus()
    return () => prev?.focus?.()
  }, [])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div
        ref={ref}
        className={`modal ${props.className ?? ''}`}
        style={{ width: props.width }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={props.title !== null ? titleId : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.stopPropagation(); props.onClose() }
        }}
      >
        {props.title !== null && <div className="modal-head" id={titleId}>{props.title}</div>}
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  )
}

// ---------- Context menu / dropdown ----------
export interface MenuItem { label?: string; kbd?: string; onClick?: () => void; disabled?: boolean; checked?: boolean; sep?: boolean; header?: string; submenu?: MenuItem[]; danger?: boolean }

interface MenuState { items: MenuItem[] | null; x: number; y: number }
const useMenu = create<MenuState>(() => ({ items: null, x: 0, y: 0 }))

export const openMenu = (items: MenuItem[], x: number, y: number): void => useMenu.setState({ items, x, y })
export const closeMenu = (): void => useMenu.setState({ items: null })
export const menuAt = (e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation?: () => void }, items: MenuItem[]): void => {
  e.preventDefault()
  e.stopPropagation?.()
  openMenu(items, e.clientX, e.clientY)
}
export const menuBelow = (el: HTMLElement, items: MenuItem[]): void => {
  const r = el.getBoundingClientRect()
  openMenu(items, r.left, r.bottom + 2)
}

function MenuList({ items, x, y, depth }: { items: MenuItem[]; x: number; y: number; depth: number }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [active, setActive] = useState(-1)
  const [sub, setSub] = useState<{ i: number; x: number; y: number } | null>(null)
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect()
    setPos({ x: Math.max(4, Math.min(x, innerWidth - r.width - 4)), y: Math.max(4, Math.min(y, innerHeight - r.height - 4)) })
    if (depth === 0) ref.current!.focus()
  }, [x, y, depth])
  const enabled = items.map((it, i) => (!it.sep && !it.header && !it.disabled ? i : -1)).filter((i) => i >= 0)
  return (
    <div
      ref={ref}
      className="popover menu"
      style={{ left: pos.x, top: pos.y, zIndex: 60 + depth }}
      tabIndex={-1}
      role="menu"
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const k = enabled.indexOf(active)
          setActive(enabled[(k + (e.key === 'ArrowDown' ? 1 : enabled.length - 1)) % enabled.length])
        } else if (e.key === 'Enter' && active >= 0) {
          const it = items[active]
          if (it.submenu) { const r = ref.current!.children[active].getBoundingClientRect(); setSub({ i: active, x: r.right, y: r.top }) } else { closeMenu(); it.onClick?.() }
        } else if (e.key === 'Escape') closeMenu()
      }}
    >
      {items.map((it, i) =>
        it.sep ? <div key={i} className="menu-sep" /> : it.header ? <div key={i} className="menu-label">{it.header}</div> : (
          <div
            key={i}
            role="menuitem"
            className={`menu-item ${it.disabled ? 'disabled' : ''} ${active === i ? 'active' : ''}`}
            style={it.danger ? { color: 'var(--danger)' } : undefined}
            onMouseEnter={(e) => {
              setActive(i)
              if (it.submenu) { const r = e.currentTarget.getBoundingClientRect(); setSub({ i, x: r.right, y: r.top - 4 }) } else setSub(null)
            }}
            onMouseUp={() => { if (!it.submenu) { closeMenu(); it.onClick?.() } }}
          >
            <span style={{ width: 12 }}>{it.checked ? '✓' : ''}</span>
            <span>{it.label}</span>
            {it.submenu ? <span className="kbd">▸</span> : it.kbd && <span className="kbd">{it.kbd}</span>}
          </div>
        )
      )}
      {sub && items[sub.i]?.submenu && <MenuList items={items[sub.i].submenu!} x={sub.x} y={sub.y} depth={depth + 1} />}
    </div>
  )
}

export function MenuHost(): ReactNode {
  const { items, x, y } = useMenu()
  useEffect(() => {
    if (!items) return
    const close = (e: MouseEvent): void => { if (!(e.target as HTMLElement).closest('.menu')) closeMenu() }
    const t = setTimeout(() => window.addEventListener('mousedown', close), 0)
    window.addEventListener('blur', closeMenu)
    return () => { clearTimeout(t); window.removeEventListener('mousedown', close); window.removeEventListener('blur', closeMenu) }
  }, [items])
  return items ? <MenuList items={items} x={x} y={y} depth={0} /> : null
}

// ---------- Popover anchored to an element ----------
export function Popover(props: { anchor: HTMLElement | null; onClose: () => void; children: ReactNode; width?: number; align?: 'left' | 'right' }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: -9999, y: -9999 })
  useLayoutEffect(() => {
    if (!props.anchor) return
    const a = props.anchor.getBoundingClientRect()
    const r = ref.current!.getBoundingClientRect()
    let x = props.align === 'right' ? a.right - r.width : a.left
    let y = a.bottom + 4
    if (y + r.height > innerHeight - 4) y = Math.max(4, a.top - r.height - 4)
    x = Math.max(4, Math.min(x, innerWidth - r.width - 4))
    setPos({ x, y })
  }, [props.anchor, props.align])
  useEffect(() => {
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node) && !props.anchor?.contains(e.target as Node) && !(e.target as HTMLElement).closest('.menu')) props.onClose()
    }
    const t = setTimeout(() => window.addEventListener('mousedown', close), 0)
    return () => { clearTimeout(t); window.removeEventListener('mousedown', close) }
  }, [props])
  return (
    <div ref={ref} className="popover" style={{ left: pos.x, top: pos.y, width: props.width }} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), props.onClose())}>
      {props.children}
    </div>
  )
}

// ---------- promise dialogs ----------
interface DialogReq { kind: 'confirm' | 'prompt'; title: string; message?: ReactNode; ok?: string; danger?: boolean; value?: string; password?: boolean; requireText?: string; resolve: (v: string | boolean | null) => void }
const useDialog = create<{ req: DialogReq | null }>(() => ({ req: null }))

export const confirmDialog = (title: string, message?: ReactNode, opts: { ok?: string; danger?: boolean; requireText?: string } = {}): Promise<boolean> =>
  new Promise((resolve) => useDialog.setState({ req: { kind: 'confirm', title, message, ...opts, resolve: (v) => resolve(!!v) } }))

export const promptDialog = (title: string, value = '', opts: { message?: ReactNode; ok?: string; password?: boolean } = {}): Promise<string | null> =>
  new Promise((resolve) => useDialog.setState({ req: { kind: 'prompt', title, value, ...opts, resolve: (v) => resolve(v as string | null) } }))

export function DialogHost(): ReactNode {
  const req = useDialog((s) => s.req)
  const [text, setText] = useState('')
  useEffect(() => setText(req?.value ?? ''), [req])
  if (!req) return null
  const done = (v: string | boolean | null): void => { useDialog.setState({ req: null }); req.resolve(v) }
  const blocked = !!req.requireText && text !== req.requireText
  const submit = (): void => { if (!blocked) done(req.kind === 'prompt' ? text : true) }
  return (
    <Modal
      title={req.title}
      onClose={() => done(req.kind === 'prompt' ? null : false)}
      width={420}
      footer={
        <>
          <button className="btn" onClick={() => done(req.kind === 'prompt' ? null : false)}>Cancel</button>
          <button className={`btn ${req.danger ? 'danger' : 'primary'}`} disabled={blocked} onClick={submit}>{req.ok ?? 'OK'}</button>
        </>
      }
    >
      {req.message && <div className="selectable" style={{ whiteSpace: 'pre-wrap' }}>{req.message}</div>}
      {(req.kind === 'prompt' || req.requireText) && (
        <input
          className="input"
          autoFocus
          type={req.password ? 'password' : 'text'}
          placeholder={req.requireText ? `Type "${req.requireText}" to confirm` : ''}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      )}
    </Modal>
  )
}

export function Toasts(): ReactNode {
  const list = useToasts((s) => s.list)
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {list.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
    </div>
  )
}

/** Horizontal or vertical drag handle; reports the delta in px. */
export function Resizer({ onDrag, vertical }: { onDrag: (delta: number) => void; vertical?: boolean }): ReactNode {
  const [drag, setDrag] = useState(false)
  return (
    <div
      className={`resizer ${vertical ? 'h' : ''} ${drag ? 'dragging' : ''}`}
      role="separator"
      onMouseDown={(e) => {
        e.preventDefault()
        let last = vertical ? e.clientY : e.clientX
        setDrag(true)
        const move = (ev: MouseEvent): void => { const p = vertical ? ev.clientY : ev.clientX; onDrag(p - last); last = p }
        const up = (): void => { setDrag(false); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }}
    />
  )
}
