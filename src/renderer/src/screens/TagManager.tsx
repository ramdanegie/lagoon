import { type ReactNode, useEffect, useState } from 'react'
import type { Tag } from '@shared/types'
import { call, fail } from '../lib/api'
import { Modal } from '../components/ui'

const DEFAULT_COLORS: Record<string, string> = { local: '#8e8e93', testing: '#34c759', development: '#007aff', staging: '#ff9500', production: '#ff3b30' }

export function TagManager({ onClose }: { onClose: () => void }): ReactNode {
  const [tags, setTags] = useState<Tag[]>([])
  const [name, setName] = useState('')
  useEffect(() => { void call<Tag[]>('tag.list').then(setTags) }, [])
  const save = (t: Partial<Tag> & { name: string; color: string }): void => void call<Tag[]>('tag.save', t).then(setTags).catch(fail)
  return (
    <Modal title="Tags" onClose={onClose} width={420} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <div className="col" style={{ gap: 'var(--sp-3)' }}>
        {tags.map((t) => (
          <div key={t.id} className="row">
            <input type="color" aria-label={`${t.name} color`} value={t.color} onChange={(e) => save({ ...t, color: e.target.value })} style={{ width: 28, height: 22, border: 0, background: 'none', padding: 0 }} />
            <span className="badge" style={{ background: t.color }}>{t.name}</span>
            <span className="grow" />
            {t.builtin ? (
              <button className="btn sm ghost" disabled={DEFAULT_COLORS[t.id] === t.color} onClick={() => save({ ...t, color: DEFAULT_COLORS[t.id] })}>Default color</button>
            ) : (
              <button className="btn sm ghost" onClick={() => void call<Tag[]>('tag.delete', t.id).then(setTags)}>Delete</button>
            )}
          </div>
        ))}
      </div>
      <div className="row">
        <input className="input grow" placeholder="New tag name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && (save({ name: name.trim(), color: '#5ac8fa' }), setName(''))} />
        <button className="btn" disabled={!name.trim()} onClick={() => { save({ name: name.trim(), color: '#5ac8fa' }); setName('') }}>Add</button>
      </div>
    </Modal>
  )
}
