import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DEFAULTS } from '@shared/settings'
import { sha256Hex } from '@shared/keymap'
import { call, on, useSetting, useSettings } from '../lib/api'
import { Icon } from '../components/Icon'
import '../styles/settings.css'

/** Full-window lock while a passcode is set and the app is locked (startup, or away longer than the auto-lock time). Main owns the state. */
export function PasscodeLock(): ReactNode {
  const [hash] = useSetting('security.passcodeHash', DEFAULTS['security.passcodeHash'])
  const loaded = useSettings((s) => s.loaded)
  const [locked, setLocked] = useState<boolean | null>(null)
  useEffect(() => {
    void call<boolean>('lock.get').then(setLocked)
    return on('lock:changed', (v: boolean) => setLocked(v))
  }, [])
  if (loaded && locked !== null && (!hash || !locked)) return null
  // until settings and lock state are known, cover the window so nothing shows through
  return <LockScreen ready={loaded && locked !== null} hash={hash} />
}

function LockScreen({ ready, hash }: { ready: boolean; hash: string }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  // keep keyboard focus out of the app behind the lock
  useLayoutEffect(() => {
    const sibs = [...(ref.current?.parentElement?.children ?? [])].filter((el) => el !== ref.current)
    sibs.forEach((el) => el.setAttribute('inert', ''))
    return () => sibs.forEach((el) => el.removeAttribute('inert'))
  }, [])
  const unlock = async (): Promise<void> => {
    if ((await sha256Hex(code)) !== hash) { setErr('Wrong passcode'); setCode(''); return }
    setCode('')
    void call('lock.set', false)
  }
  return (
    <div ref={ref} className="lock-screen" role="dialog" aria-modal="true" aria-label="Lagoon is locked">
      {ready && (
        <form className="lock-card" onSubmit={(e) => { e.preventDefault(); void unlock() }}>
          <Icon name="lock" size={28} />
          <div className="lock-title">Lagoon is locked</div>
          <label className="sr-only" htmlFor="lock-code">Passcode</label>
          <input id="lock-code" className="input" type="password" autoFocus placeholder="Passcode" value={code} aria-invalid={!!err} aria-describedby={err ? 'lock-err' : undefined} onChange={(e) => { setCode(e.target.value); setErr('') }} />
          {err && <div id="lock-err" className="danger-text" role="alert">{err}</div>}
          <button className="btn primary" type="submit" disabled={!code}>Unlock</button>
        </form>
      )}
    </div>
  )
}
