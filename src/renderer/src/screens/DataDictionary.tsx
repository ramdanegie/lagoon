// Data dictionary: documentation of the current schema as one self-contained HTML file or Markdown.
import { type ReactNode, useEffect, useState } from 'react'
import { dictHtml, dictMarkdown, type Dict } from '@shared/dictionary'
import { call, errText, fail, toast } from '../lib/api'
import { useWs } from '../lib/ws'
import { Modal } from '../components/ui'
import '../styles/datagen.css'

type Fmt = 'html' | 'md'

export function DataDictionary(p: { onClose: () => void }): ReactNode {
  const sessionId = useWs((s) => s.sessionId)
  const schema = useWs((s) => s.schema) ?? ''
  const [dict, setDict] = useState<Dict>()
  const [err, setErr] = useState('')
  const [fmt, setFmt] = useState<Fmt>('html')
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let live = true
    call<Dict>('dict.build', sessionId, schema).then((d) => live && setDict(d), (e) => live && setErr(errText(e)))
    return () => { live = false }
  }, [sessionId, schema, nonce])
  const refresh = (): void => { setDict(undefined); setErr(''); setNonce((n) => n + 1) }

  const text = dict ? (fmt === 'html' ? dictHtml(dict) : dictMarkdown(dict)) : ''
  const save = async (): Promise<void> => {
    if (!dict) return
    const base = `${dict.database ?? dict.schema}${dict.schema && dict.schema !== dict.database ? `_${dict.schema}` : ''}_dictionary`.replace(/[/\\:*?"<>|]/g, '_')
    const path = await call<string | undefined>('dialog.save', { defaultPath: `${base}.${fmt}`, filters: fmt === 'html' ? [{ name: 'HTML', extensions: ['html'] }] : [{ name: 'Markdown', extensions: ['md'] }] })
    if (!path) return
    try {
      await call('file.write', path, text)
      toast('Data dictionary saved', 'success')
    } catch (e) { fail(e) }
  }

  return (
    <Modal
      title="Data dictionary"
      onClose={p.onClose}
      width={980}
      footer={
        <>
          <span className="grow muted">{dict ? `${dict.tables.length} tables · ${dict.views.length} views · ${dict.routines.length} functions` : ''}</span>
          <button className="btn" onClick={p.onClose}>Close</button>
          <button className="btn primary" disabled={!dict} onClick={() => void save()}>Save…</button>
        </>
      }
    >
      <div className="dict-bar">
        <div className="tabs" role="tablist" aria-label="Format">
          {([['html', 'HTML'], ['md', 'Markdown']] as const).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={fmt === id} className={fmt === id ? 'on' : ''} onClick={() => setFmt(id)}>{label}</button>
          ))}
        </div>
        <span className="grow muted ellipsis">Schema {schema || '(default)'}</span>
        <button className="btn sm" disabled={!dict && !err} onClick={refresh}>Refresh</button>
      </div>
      {err && <div className="danger-text selectable">{err}</div>}
      {!dict && !err && <div className="empty" role="status">Reading the schema…</div>}
      {dict && (fmt === 'html'
        ? <iframe className="dict-frame" title="Data dictionary preview" sandbox="allow-same-origin" srcDoc={text} />
        : <pre className="code dict-md selectable" aria-label="Markdown preview">{text}</pre>)}
    </Modal>
  )
}
