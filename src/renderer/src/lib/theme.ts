// Themes: built-in light/dark from tokens.css, plus custom themes stored in settings as
// { name, base: 'light'|'dark', colors: { '--accent': '#hex', ... } }. Per-key overrides live in 'theme.overrides'.
export interface CustomTheme { name: string; base: 'light' | 'dark'; colors: Record<string, string> }

export const BUILTIN_THEMES: CustomTheme[] = [
  { name: 'Graphite', base: 'dark', colors: {} },
  { name: 'Paper', base: 'light', colors: {} },
  { name: 'Forest', base: 'dark', colors: { '--bg-app': '#1a201c', '--bg-panel': '#1f2621', '--bg-sidebar': '#1c221e', '--bg-elev': '#263029', '--accent': '#4cc38a', '--bg-selected': '#24513a', '--bg-selected-soft': '#203a2c' } },
  { name: 'Dusk', base: 'dark', colors: { '--bg-app': '#1d1b26', '--bg-panel': '#23202e', '--bg-sidebar': '#201d2a', '--bg-elev': '#2b2838', '--accent': '#b18cff', '--bg-selected': '#43386b', '--bg-selected-soft': '#332b52' } },
  { name: 'Sand', base: 'light', colors: { '--bg-app': '#f5f1ea', '--bg-panel': '#fffdf9', '--bg-sidebar': '#efe9df', '--accent': '#c2611f', '--bg-selected': '#f6dcc4', '--bg-selected-soft': '#fbebdc' } }
]

let applied: string[] = []

export function applyCustomTheme(name: string | null, base: 'light' | 'dark', s: Record<string, unknown>): void {
  const root = document.documentElement
  applied.forEach((k) => root.style.removeProperty(k))
  applied = []
  const custom = (s['themes.custom'] as CustomTheme[] | undefined) ?? []
  const theme = name ? [...BUILTIN_THEMES, ...custom].find((t) => t.name === name) : undefined
  root.dataset.theme = theme?.base ?? base
  const colors = { ...(theme?.colors ?? {}), ...((s['theme.overrides'] as Record<string, string>) ?? {}) }
  for (const [k, v] of Object.entries(colors)) {
    root.style.setProperty(k, v)
    applied.push(k)
  }
}
