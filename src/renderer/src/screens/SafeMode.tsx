import { type ReactNode, useState } from 'react'
import { SAFE_MODES } from '@shared/types'
import { call } from '../lib/api'
import { useSafe, ws } from '../lib/ws'
import { Modal } from '../components/ui'

/** Confirmation / password sheet shown before statements are sent on Alert and Safe levels. */
export function SafeModeHost(): ReactNode {
  const req = useSafe((s) => s.req)
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  if (!req) return null
  const done = (ok: boolean): void => { useSafe.setState({ req: null }); setPw(''); setErr(''); req.resolve(ok) }
  const send = async (): Promise<void> => {
    if (req.password && !(await call<boolean>('session.checkPassword', ws().sessionId, pw))) { setErr('Wrong database password'); return }
    done(true)
  }
  const level = SAFE_MODES[ws().conn?.safeMode ?? 0]
  return (
    <Modal
      title={<><span>Confirm before sending</span><span className="badge" style={{ background: 'var(--warning)' }}>{level}</span></>}
      onClose={() => done(false)}
      width={620}
      footer={<><button className="btn" onClick={() => done(false)}>Cancel</button><button className="btn primary" onClick={send}>Send</button></>}
    >
      <div className="muted">{req.stmts.length} statement{req.stmts.length > 1 ? 's' : ''} will run on <b>{ws().conn?.name}</b>{ws().database ? ` / ${ws().database}` : ''}.</div>
      <pre className="code" style={{ maxHeight: 280 }}>{req.stmts.join(';\n\n')}</pre>
      {req.password && (
        <>
          <input className="input" type="password" autoFocus placeholder="Database password" aria-label="Database password" value={pw} onChange={(e) => { setPw(e.target.value); setErr('') }} onKeyDown={(e) => e.key === 'Enter' && send()} aria-invalid={!!err} />
          {err && <div className="danger-text">{err}</div>}
        </>
      )}
    </Modal>
  )
}

export function PreviewModal({ sql, onClose, onCommit, onDiscard }: { sql: string[]; onClose: () => void; onCommit: () => void; onDiscard: () => void }): ReactNode {
  return (
    <Modal
      title="Pending changes"
      onClose={onClose}
      width={680}
      footer={
        <>
          <button className="btn ghost" style={{ marginRight: 'auto' }} onClick={() => navigator.clipboard.writeText(sql.join('\n'))}>Copy SQL</button>
          <button className="btn" onClick={() => { onDiscard(); onClose() }}>Discard</button>
          <button className="btn primary" onClick={() => { onClose(); onCommit() }}>Commit</button>
        </>
      }
    >
      {sql.length ? <pre className="code" style={{ maxHeight: '55vh' }}>{sql.join('\n')}</pre> : <div className="empty">Nothing to commit.</div>}
    </Modal>
  )
}
