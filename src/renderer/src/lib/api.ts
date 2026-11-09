import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { COMMANDS, prettyAccel } from '@shared/commands'

export const call = <T = unknown>(method: string, ...args: unknown[]): Promise<T> => window.api.call<T>(method, ...args)
export const on = (event: string, cb: (...a: never[]) => void): (() => void) => window.api.on(event, cb as (...a: unknown[]) => void)
export const isMac = window.api.platform === 'darwin'

// ---------- settings (live, shared across windows) ----------
interface SettingsState { s: Record<string, unknown>; loaded: boolean }
export const useSettings = create<SettingsState>(() => ({ s: {}, loaded: false }))
call<Record<string, unknown>>('settings.all').then((s) => useSettings.setState({ s, loaded: true }))
on('settings:changed', (k: string, v: unknown) => useSettings.setState((st) => ({ s: { ...st.s, [k]: v } })))
export function setting(key: string, fallback: string): string
export function setting(key: string, fallback: number): number
export function setting(key: string, fallback: boolean): boolean
export function setting<T>(key: string, fallback: T): T
export function setting<T>(key: string, fallback: T): T {
  const v = useSettings.getState().s[key]
  return v === undefined ? fallback : (v as T)
}
export function useSetting(key: string, fallback: string): [string, (v: string) => void]
export function useSetting(key: string, fallback: number): [number, (v: number) => void]
export function useSetting(key: string, fallback: boolean): [boolean, (v: boolean) => void]
export function useSetting<T>(key: string, fallback: T): [T, (v: T) => void]
export function useSetting<T>(key: string, fallback: T): [T, (v: T) => void] {
  const v = useSettings((st) => st.s[key])
  return [v === undefined ? fallback : (v as T), (nv: T) => saveSetting(key, nv)]
}
/** Update the local copy right away (controls react without waiting for the main process), then persist. */
export function saveSetting(key: string, v: unknown): void {
  useSettings.setState((st) => ({ s: { ...st.s, [key]: v } }))
  void call('settings.set', key, v)
}

// ---------- command bus ----------
// Menu accelerators arrive as 'command' events. Handlers register with a scope; the most recently focused
// scope that handles an id wins, then 'global'. This resolves overloaded keys like ⌘I, ⌘F, ⌘↩.
type Handler = () => void | boolean
const scopes = new Map<string, Record<string, Handler>>()
let focusOrder: string[] = []

export function focusScope(scope: string): void {
  focusOrder = [scope, ...focusOrder.filter((s) => s !== scope)]
}

export function dispatch(id: string): void {
  for (const scope of [...focusOrder, 'global']) {
    const h = scopes.get(scope)?.[id]
    if (h && h() !== false) return
  }
}
on('command', (id: string) => dispatch(id))

/** Register handlers for a scope while mounted. Handlers may return false to pass the command on. */
export function useCommands(scope: string, handlers: Record<string, Handler>): void {
  const ref = useRef(handlers)
  ref.current = handlers
  useEffect(() => {
    const proxy: Record<string, Handler> = {}
    for (const k of Object.keys(ref.current)) proxy[k] = () => ref.current[k]?.()
    scopes.set(scope, proxy)
    if (!focusOrder.includes(scope)) focusOrder.push(scope)
    return () => {
      scopes.delete(scope)
      focusOrder = focusOrder.filter((s) => s !== scope)
    }
  }, [scope, Object.keys(handlers).join()])
}

export function shortcut(id: string): string {
  const custom = setting<Record<string, string | null>>('keymap', {})
  const def = COMMANDS.find((c) => c.id === id)?.accel
  return prettyAccel(id in custom ? (custom[id] ?? undefined) : def, isMac)
}

export const tip = (label: string, id?: string): string => (id && shortcut(id) ? `${label} (${shortcut(id)})` : label)

// ---------- toasts ----------
export interface Toast { id: number; text: string; kind: 'info' | 'error' | 'success' }
export const useToasts = create<{ list: Toast[] }>(() => ({ list: [] }))
let tid = 0
export function toast(text: string, kind: Toast['kind'] = 'info', ms = kind === 'error' ? 8000 : 3500): void {
  const id = ++tid
  useToasts.setState((s) => ({ list: [...s.list, { id, text, kind }] }))
  setTimeout(() => useToasts.setState((s) => ({ list: s.list.filter((t) => t.id !== id) })), ms)
}
export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method 'rpc': (Error: )?/, '')
export const fail = (e: unknown): void => toast(errText(e), 'error')

export const uid = (): string => crypto.randomUUID()
