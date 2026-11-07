// Settings logic without UI: accelerator recording/normalisation/conflicts (Keymap pane, plugin shortcuts),
// the passcode digest (Security pane) and theme JSON validation (Fonts & Themes pane).

export interface KeyLike { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

const CODE_KEYS: Record<string, string> = {
  BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Slash: '/', Backslash: '\\', Comma: ',', Period: '.',
  Semicolon: ';', Quote: "'", Backquote: '`', Enter: 'Enter', NumpadEnter: 'Enter', Backspace: 'Backspace', Delete: 'Delete',
  Tab: 'Tab', Space: 'Space', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Escape: 'Escape'
}

/** Electron key name from KeyboardEvent.code (layout-independent, so ⌥] does not turn into a symbol). */
function keyName(e: KeyLike): string | undefined {
  const c = e.code
  if (/^Key[A-Z]$/.test(c)) return c.slice(3)
  if (/^Digit\d$/.test(c)) return c.slice(5)
  if (/^Numpad\d$/.test(c)) return `num${c.slice(6)}`
  if (/^F([1-9]|1\d|2[0-4])$/.test(c)) return c
  return CODE_KEYS[c]
}

export type Recorded = { kind: 'cancel' } | { kind: 'clear' } | { kind: 'wait' } | { kind: 'error'; message: string } | { kind: 'accel'; accel: string }

/** Turn a keydown into an accelerator: Esc cancels, Backspace/Delete alone clears, modifiers alone wait. */
export function recordKey(e: KeyLike, mac: boolean): Recorded {
  const mods = e.metaKey || e.ctrlKey || e.altKey || e.shiftKey
  if (e.key === 'Escape' && !mods) return { kind: 'cancel' }
  if ((e.key === 'Backspace' || e.key === 'Delete') && !mods) return { kind: 'clear' }
  if (['Meta', 'Control', 'Alt', 'Shift', 'OS', 'CapsLock', 'Fn'].includes(e.key)) return { kind: 'wait' }
  const key = keyName(e)
  if (!key) return { kind: 'error', message: 'This key cannot be used in a shortcut' }
  const cmd = mac ? e.metaKey : e.ctrlKey
  const ctrl = mac && e.ctrlKey
  if (!cmd && !ctrl && !/^F\d+$/.test(key)) return { kind: 'error', message: `Include ${mac ? '⌘ or ⌃' : 'Ctrl'} (function keys may be used alone)` }
  const parts = [cmd && 'CmdOrCtrl', ctrl && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', !mac && e.metaKey && 'Super', key].filter(Boolean)
  return { kind: 'accel', accel: parts.join('+') }
}

const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Cmd', 'Super']

/** Platform-effective form used for comparisons, e.g. CmdOrCtrl+Shift+s → Shift+Cmd+S on macOS, Ctrl+Shift+S elsewhere. */
export function canonicalAccel(a: string, mac: boolean): string {
  // main/index.ts maps ⌘⌃ shortcuts to Ctrl+Alt+Shift off macOS; compare against what the menu really uses
  const src = !mac ? a.replace(/^(CmdOrCtrl|CommandOrControl)\+(Ctrl|Control)\+/i, 'Ctrl+Alt+Shift+') : a
  const parts = src.split('+')
  let key = parts.pop() ?? ''
  if (key === '' && src.endsWith('++')) key = 'Plus'
  const mods = new Set<string>()
  for (const p of parts) {
    const l = p.toLowerCase()
    if (l === 'cmdorctrl' || l === 'commandorcontrol') mods.add(mac ? 'Cmd' : 'Ctrl')
    else if (l === 'cmd' || l === 'command' || l === 'meta' || l === 'super') mods.add(mac ? 'Cmd' : 'Super')
    else if (l === 'ctrl' || l === 'control') mods.add('Ctrl')
    else if (l === 'alt' || l === 'option' || l === 'altgr') mods.add('Alt')
    else if (l === 'shift') mods.add('Shift')
  }
  const alias: Record<string, string> = { return: 'Enter', esc: 'Escape', del: 'Delete', space: 'Space', left: 'Left', right: 'Right', up: 'Up', down: 'Down' }
  key = alias[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase() : key)
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+')
}

export const sameAccel = (a: string | null | undefined, b: string | null | undefined, mac: boolean): boolean =>
  !!a && !!b && canonicalAccel(a, mac) === canonicalAccel(b, mac)

/** Current accelerator per command: custom keymap entry (null = removed) or the default. */
export function effectiveKeymap(commands: { id: string; accel?: string }[], custom: Record<string, string | null>): Record<string, string | undefined> {
  return Object.fromEntries(commands.map((c) => [c.id, c.id in custom ? (custom[c.id] ?? undefined) : c.accel]))
}

/** Id of another command already bound to `accel`, if any. */
export function findConflict(accel: string, bindings: Record<string, string | undefined>, exceptId: string | undefined, mac: boolean): string | undefined {
  return Object.keys(bindings).find((id) => id !== exceptId && sameAccel(bindings[id], accel, mac))
}

/** New keymap after binding `id` to `accel` (null = remove); entries equal to the default are dropped. */
export function setBinding(custom: Record<string, string | null>, id: string, accel: string | null, def: string | undefined): Record<string, string | null> {
  const next = { ...custom }
  if ((accel ?? undefined) === def) delete next[id]
  else next[id] = accel
  return next
}

// ---------- passcode ----------
/** Hex SHA-256 via Web Crypto (renderer and Node); only this digest of the app passcode is stored. */
export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ---------- themes ----------
export interface ThemeJson { name: string; base: 'light' | 'dark'; colors: Record<string, string> }

const COLOR = /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|rgba|hsl|hsla)\(\s*[\d.%\s,/+-]+\))$/i
/** Colors a theme file may hold: hex, rgb[a]() or hsl[a]() (no names or url()). */
export const isColor = (s: string): boolean => COLOR.test(s.trim())

/** Accepts one theme, an array, or { themes: [...] }. Throws on the first invalid entry. */
export function parseThemes(raw: unknown, allowedVars: string[]): ThemeJson[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { themes?: unknown }).themes) ? (raw as { themes: unknown[] }).themes : [raw]
  if (!list.length) throw new Error('The file contains no themes')
  return list.map((t, i) => {
    const where = list.length > 1 ? `Theme ${i + 1}` : 'Theme'
    const o = t as Record<string, unknown>
    if (!o || typeof o !== 'object') throw new Error(`${where} must be an object`)
    if (typeof o.name !== 'string' || !o.name.trim() || o.name.length > 60) throw new Error(`${where}: "name" must be text of 1–60 characters`)
    if (o.base !== 'light' && o.base !== 'dark') throw new Error(`${where}: "base" must be "light" or "dark"`)
    const colors = o.colors ?? {}
    if (typeof colors !== 'object' || Array.isArray(colors)) throw new Error(`${where}: "colors" must be an object`)
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(colors as Record<string, unknown>)) {
      if (!allowedVars.includes(k)) throw new Error(`${where}: unknown color "${k}"`)
      if (typeof v !== 'string' || !isColor(v)) throw new Error(`${where}: "${k}" is not a color (use #rrggbb, rgb() or hsl())`)
      out[k] = v.trim()
    }
    return { name: o.name.trim(), base: o.base, colors: out }
  })
}

/** #rrggbb plus alpha (0–1) from #rgb[a], #rrggbb[aa] or rgb[a](); undefined for anything else. */
export function splitColor(css: string): { hex: string; alpha: number } | undefined {
  const s = css.trim()
  let m = /^#([0-9a-f]{3,4})$/i.exec(s)
  if (m) return splitColor('#' + [...m[1]].map((c) => c + c).join(''))
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s)
  if (m) return { hex: `#${m[1].toLowerCase()}`, alpha: m[2] ? parseInt(m[2], 16) / 255 : 1 }
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(s)
  if (!m) return
  const hex = '#' + m.slice(1, 4).map((n) => Math.min(255, +n).toString(16).padStart(2, '0')).join('')
  const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
  return { hex, alpha }
}

/** Inverse of splitColor: opaque colors stay #rrggbb, translucent ones get an alpha byte. */
export const joinColor = (hex: string, alpha: number): string =>
  alpha >= 1 ? hex.toLowerCase() : hex.toLowerCase() + Math.round(Math.max(0, alpha) * 255).toString(16).padStart(2, '0')
