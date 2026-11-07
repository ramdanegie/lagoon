import { type ReactNode, Suspense, lazy, useEffect, useState } from 'react'
import { useSettings, useCommands, call } from './lib/api'
import { MenuHost, DialogHost, Toasts } from './components/ui'
// heavy screens (editor, charts, dialogs) load on first use; see Workspace
const Workspace = lazy(() => import('./screens/Workspace').then((m) => ({ default: m.Workspace })))
const SettingsModal = lazy(() => import('./screens/Settings').then((m) => ({ default: m.SettingsModal })))
import { applyCustomTheme } from './lib/theme'
import { PasscodeLock } from './screens/PasscodeLock'
import { Tour, startTour } from './components/Tour'

const params = new URLSearchParams(location.search)

function useTheme(): void {
  const s = useSettings((st) => st.s)
  const [dark, setDark] = useState(matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const m = matchMedia('(prefers-color-scheme: dark)')
    const h = (e: MediaQueryListEvent): void => setDark(e.matches)
    m.addEventListener('change', h)
    return () => m.removeEventListener('change', h)
  }, [])
  useEffect(() => {
    const t = (s['theme'] as string) ?? 'auto'
    const base = t === 'auto' ? (dark ? 'dark' : 'light') : t === 'light' || t === 'dark' ? t : undefined
    applyCustomTheme(base ? null : t, base ?? 'dark', s)
    const root = document.documentElement.style
    root.setProperty('--grid-font-size', `${(s['fonts.gridSize'] as number) ?? 12}px`)
    root.setProperty('--editor-font-size', `${(s['fonts.editorSize'] as number) ?? 13}px`)
    root.setProperty('--sidebar-font-size', `${(s['fonts.sidebarSize'] as number) ?? 13}px`)
    if (s['fonts.gridFamily']) root.setProperty('--font-mono', `${s['fonts.gridFamily']}, ui-monospace, monospace`)
    else root.removeProperty('--font-mono')
    root.setProperty('--h-row', `${Math.round(((s['fonts.gridSize'] as number) ?? 12) * 1.85)}px`)
  }, [s, dark])
}

export function App(): ReactNode {
  useTheme()
  const [settings, setSettings] = useState(false)
  useCommands('global', {
    'app.settings': () => setSettings(true),
    'file.newWindow': () => void call('window.open', { view: 'main' }),
    'help.tour': () => startTour(),
    'view.theme': () => {
      const cur = document.documentElement.dataset.theme
      void call('settings.set', 'theme', cur === 'dark' ? 'light' : 'dark')
    }
  })
  return (
    <>
      <Suspense fallback={null}>
        <Workspace connectionId={params.get('conn') ?? undefined} file={params.get('file') ?? undefined} />
        {settings && <SettingsModal onClose={() => setSettings(false)} />}
      </Suspense>
      <MenuHost />
      <DialogHost />
      <Toasts />
      <Tour />
      <PasscodeLock />
    </>
  )
}
