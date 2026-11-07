import { type ReactNode, useMemo, useState } from 'react'
import { Modal } from '../components/ui'

const asJson = (s: string): unknown => { try { const v = JSON.parse(s); return typeof v === 'object' && v !== null ? v : undefined } catch { return undefined } }

/** Image preview for hex-encoded blobs (\x… from Postgres, or plain hex). */
function imageSrc(v: string): string | null {
  const hex = v.startsWith('\\x') ? v.slice(2) : /^[0-9a-f]+$/i.test(v) && v.length > 16 ? v : null
  if (!hex) return null
  const head = hex.slice(0, 16).toLowerCase()
  const mime = head.startsWith('89504e47') ? 'image/png' : head.startsWith('ffd8ff') ? 'image/jpeg' : head.startsWith('47494638') ? 'image/gif' : head.startsWith('52494646') ? 'image/webp' : null
  if (!mime) return null
  const bytes = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)))
  return URL.createObjectURL(new Blob([bytes], { type: mime }))
}

function Tree({ v, name, depth = 0 }: { v: unknown; name?: string; depth?: number }): ReactNode {
  const [open, setOpen] = useState(depth < 2)
  const isObj = typeof v === 'object' && v !== null
  return (
    <div style={{ paddingLeft: depth ? 14 : 0 }} className="mono">
      <span onClick={() => isObj && setOpen(!open)} style={{ cursor: isObj ? 'pointer' : undefined }}>
        {isObj ? (open ? '▾ ' : '▸ ') : '  '}
        {name !== undefined && <span style={{ color: 'var(--syn-ident)' }}>{name}: </span>}
        {isObj ? <span className="faint">{Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v as object).length}}`}</span>
          : <span style={{ color: typeof v === 'string' ? 'var(--syn-string)' : 'var(--syn-number)' }}>{JSON.stringify(v)}</span>}
      </span>
      {isObj && open && Object.entries(v as object).map(([k, x]) => <Tree key={k} v={x} name={k} depth={depth + 1} />)}
    </div>
  )
}

export function QuickLook({ column, value, readOnly, onSave, onClose }: { column: string; value: unknown; readOnly?: boolean; onSave: (v: string | null) => void; onClose: () => void }): ReactNode {
  const initial = value === null || value === undefined ? '' : String(value)
  const [text, setText] = useState(initial)
  const [mode, setMode] = useState<'raw' | 'tree'>('raw')
  const json = useMemo(() => asJson(text), [text])
  const img = useMemo(() => imageSrc(initial), [initial])
  return (
    <Modal
      title={<><span>{column}</span><span className="faint" style={{ fontWeight: 400 }}>{value === null ? 'NULL' : `${initial.length} characters`}</span></>}
      onClose={onClose}
      width={720}
      footer={
        <>
          {json !== undefined && (
            <div className="seg" style={{ marginRight: 'auto' }}>
              <button className={mode === 'raw' ? 'on' : ''} onClick={() => setMode('raw')}>Raw</button>
              <button className={mode === 'tree' ? 'on' : ''} onClick={() => setMode('tree')}>Tree</button>
              <button disabled={readOnly} onClick={() => setText(JSON.stringify(json, null, 2))}>Pretty</button>
              <button disabled={readOnly} onClick={() => setText(JSON.stringify(json))}>Minify</button>
            </div>
          )}
          <button className="btn" onClick={() => navigator.clipboard.writeText(text)}>Copy</button>
          {!readOnly && <button className="btn" onClick={() => { onSave(null); onClose() }}>Set NULL</button>}
          <button className="btn" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>
          {!readOnly && <button className="btn primary" disabled={text === initial} onClick={() => { onSave(text); onClose() }}>Save</button>}
        </>
      }
    >
      {img && <img src={img} alt={`${column} preview`} style={{ maxWidth: '100%', maxHeight: 300, objectFit: 'contain', alignSelf: 'center' }} />}
      {mode === 'tree' && json !== undefined
        ? <div className="code" style={{ maxHeight: '55vh' }}><Tree v={json} /></div>
        : <textarea className="textarea" autoFocus rows={16} readOnly={readOnly} value={text} onChange={(e) => setText(e.target.value)} aria-label={`Value of ${column}`} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); if (!readOnly) { onSave(text); onClose() } } }} />}
    </Modal>
  )
}
