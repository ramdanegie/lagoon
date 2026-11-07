// Snippet library popover: search, insert at the cursor, add / edit / delete the user's own snippets.
import { type ReactNode, useState } from 'react'
import type { Dialect } from '@shared/types'
import { uid, useSetting } from '../lib/api'
import { USER_SNIPPETS, allSnippets, DIALECT_NAMES, type Snippet } from '../lib/snippets'
import { Popover } from '../components/ui'
import { Icon } from '../components/Icon'
import '../styles/explain.css'

export function SnippetsPanel({ anchor, dialect, selection, onInsert, onClose }: { anchor: HTMLElement | null; dialect: Dialect; selection: string; onInsert: (body: string) => void; onClose: () => void }): ReactNode {
  const [user, setUser] = useSetting<Snippet[]>(USER_SNIPPETS, [])
  const [q, setQ] = useState('')
  const [onlyThis, setOnlyThis] = useState(true)
  const [edit, setEdit] = useState<Snippet | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const needle = q.trim().toLowerCase()
  const list = allSnippets(user, onlyThis ? dialect : undefined).filter((s) => !needle || `${s.name}\n${s.prefix}\n${s.body}`.toLowerCase().includes(needle))

  const save = (s: Snippet): void => {
    setUser(user.some((x) => x.id === s.id) ? user.map((x) => (x.id === s.id ? s : x)) : [...user, s])
    setEdit(null)
  }

  return (
    <Popover anchor={anchor} onClose={onClose} width={440} align="right">
      {edit ? <SnippetForm initial={edit} onSave={save} onCancel={() => setEdit(null)} /> : (
        <div className="snip-pop">
          <div className="row">
            <input className="input sm grow" autoFocus placeholder="Search snippets" aria-label="Search snippets" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && list[0]) onInsert(list[0].body) }} />
            <select className="select sm" aria-label="Snippet databases" value={onlyThis ? 'this' : 'all'} onChange={(e) => setOnlyThis(e.target.value === 'this')}>
              <option value="this">{DIALECT_NAMES[dialect]}</option>
              <option value="all">All databases</option>
            </select>
            <button className="btn sm" onClick={() => setEdit({ id: uid(), name: '', prefix: '', body: selection, dialects: [] })}><Icon name="plus" size={10} /> New</button>
          </div>
          <div className="snip-list" role="list">
            {list.length === 0 && <div className="faint" style={{ padding: 'var(--sp-4)', fontSize: 'var(--fs-sm)' }}>No snippets match.</div>}
            {list.map((s) => (
              <div key={s.id} role="listitem" tabIndex={0} className="snip-item" title="Insert at cursor" onClick={() => onInsert(s.body)} onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && onInsert(s.body)}>
                <div className="row" style={{ minWidth: 0 }}>
                  <b className="ellipsis">{s.name}</b>
                  <span className="tag">{s.prefix}</span>
                  {s.dialects?.length ? <span className="faint" style={{ fontSize: 'var(--fs-xs)' }}>{s.dialects.map((x) => DIALECT_NAMES[x as Dialect] ?? x).join(', ')}</span> : null}
                </div>
                <div className="row">
                  {s.builtin ? <span className="faint" style={{ fontSize: 'var(--fs-xs)' }}>Built-in</span> : (
                    <>
                      <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); setEdit(s) }}>Edit</button>
                      <button className={`btn sm ${confirmDel === s.id ? 'danger' : 'ghost'}`} onClick={(e) => { e.stopPropagation(); if (confirmDel === s.id) setUser(user.filter((x) => x.id !== s.id)); else setConfirmDel(s.id) }} onBlur={() => setConfirmDel(null)}>{confirmDel === s.id ? 'Delete?' : 'Delete'}</button>
                    </>
                  )}
                </div>
                <div className="body">{s.body}</div>
              </div>
            ))}
          </div>
          <div className="faint" style={{ fontSize: 'var(--fs-xs)' }}>Type a prefix in the editor to complete a snippet; Tab moves between its fields.</div>
        </div>
      )}
    </Popover>
  )
}

function SnippetForm({ initial, onSave, onCancel }: { initial: Snippet; onSave: (s: Snippet) => void; onCancel: () => void }): ReactNode {
  const [s, setS] = useState(initial)
  const err = !s.name.trim() ? 'Give the snippet a name.' : !/^[\w$]+$/.test(s.prefix) ? 'The prefix is one word (letters, digits, _).' : !s.body.trim() ? 'The body is empty.' : ''
  const toggle = (d: string): void => setS({ ...s, dialects: s.dialects?.includes(d) ? s.dialects.filter((x) => x !== d) : [...(s.dialects ?? []), d] })
  return (
    <div className="snip-form">
      <b>{initial.name ? 'Edit snippet' : 'New snippet'}</b>
      <input className="input" autoFocus placeholder="Name" aria-label="Snippet name" value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} />
      <input className="input mono" placeholder="Prefix typed in the editor, e.g. selc" aria-label="Snippet prefix" value={s.prefix} onChange={(e) => setS({ ...s, prefix: e.target.value.trim() })} />
      <div className="row" style={{ fontSize: 'var(--fs-sm)' }}>
        <span className="muted">Databases</span>
        {(Object.keys(DIALECT_NAMES) as Dialect[]).map((d) => <label key={d} className="check"><input type="checkbox" checked={!!s.dialects?.includes(d)} onChange={() => toggle(d)} />{DIALECT_NAMES[d]}</label>)}
        <span className="faint">(none = all)</span>
      </div>
      <textarea className="textarea" aria-label="Snippet body" spellCheck={false} placeholder={'SELECT * FROM ${1:table} WHERE ${2:id} = ${3:1};'} value={s.body} onChange={(e) => setS({ ...s, body: e.target.value })} />
      <div className="faint" style={{ fontSize: 'var(--fs-xs)' }}>{'Fields: ${1:default}. The same number edits together; ${} marks where the cursor ends.'}</div>
      <div className="row">
        <span className="danger-text grow" style={{ fontSize: 'var(--fs-xs)' }}>{err}</span>
        <button className="btn sm" onClick={onCancel}>Cancel</button>
        <button className="btn sm primary" disabled={!!err} onClick={() => onSave({ ...s, name: s.name.trim(), builtin: undefined })}>Save</button>
      </div>
    </div>
  )
}
