// Views, materialized views, functions, procedures and sequences: edited as their SQL definition.
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { splitStatements } from '@shared/split'
import { call, errText, focusScope, toast, useCommands } from '../lib/api'
import { useWs, guard, busy, updateTab, loadObjects, registerTabApi, bumpPending, newQueryTab, type Tab } from '../lib/ws'
import { CodeEditor } from '../components/CodeEditor'

function template(d: string, kind: string, schema: string): string {
  const q = d === 'mysql' ? (s: string): string => `\`${s}\`` : (s: string): string => `"${s}"`
  const sch = d === 'sqlite' ? '' : `${q(schema)}.`
  if (kind === 'view') return `CREATE VIEW ${sch}${q('new_view')} AS\nSELECT 1 AS one;`
  if (kind === 'matview') return `CREATE MATERIALIZED VIEW ${sch}${q('new_matview')} AS\nSELECT 1 AS one;`
  if (d === 'mysql') return `CREATE FUNCTION \`new_function\`(x INT) RETURNS INT\nDETERMINISTIC\nRETURN x * 2;`
  return `CREATE OR REPLACE FUNCTION ${sch}${q('new_function')}(x integer)\nRETURNS integer\nLANGUAGE sql\nAS $$\n  SELECT x * 2;\n$$;`
}

const nameFrom = (sql: string): string | undefined => /create\s+(?:or\s+replace\s+)?(?:materialized\s+)?(?:view|function|procedure)\s+(?:if\s+not\s+exists\s+)?(?:[`"]?[\w$]+[`"]?\.)?[`"]?([\w$]+)/i.exec(sql)?.[1]

export function DdlTab({ tab }: { tab: Tab }): ReactNode {
  const s = useWs()
  const d = s.dialect ?? 'postgres'
  const [orig, setOrig] = useState('')
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const readOnly = tab.objKind === 'matview' && !tab.isNew
  const textRef = useRef(text)
  textRef.current = text

  const load = async (): Promise<void> => {
    if (tab.isNew) { const t = template(d, tab.objKind ?? 'function', tab.schema ?? ''); setOrig(''); setText(t); return }
    try {
      const sql = await call<string>('db.ddl', s.sessionId, tab.schema, tab.name, tab.objKind)
      setOrig(sql); setText(sql); setError(null)
    } catch (e) { setError(errText(e)) }
  }
  useEffect(() => { void load() }, [tab.name])

  const save = async (): Promise<boolean> => {
    const body = textRef.current
    let stmts = splitStatements(body, d).map((x) => x.sql)
    if (d === 'mysql' && !tab.isNew && (tab.objKind === 'function' || tab.objKind === 'procedure')) stmts = [`DROP ${tab.objKind.toUpperCase()} IF EXISTS \`${tab.name}\``, body.trim().replace(/;\s*$/, '')]
    if (!tab.isNew && tab.objKind === 'view' && d !== 'postgres') stmts = [`DROP VIEW IF EXISTS ${d === 'mysql' ? '`' + tab.name + '`' : '"' + tab.name + '"'}`, ...stmts.map((x) => x.replace(/^create\s+or\s+replace\s+view/i, 'CREATE VIEW'))]
    // PG functions/views come back as one CREATE OR REPLACE statement each; split would break $$ bodies only if unbalanced
    if (d === 'postgres' && (tab.objKind === 'function' || tab.objKind === 'procedure')) stmts = [body.trim().replace(/;\s*$/, '')]
    if (!(await guard(stmts))) return false
    const r = await busy(call<{ ok: boolean; index?: number; error?: string }>('db.commit', s.sessionId, stmts))
    if (!r.ok) { setError(r.error ?? 'Failed'); toast(r.error ?? 'Failed', 'error'); return false }
    setError(null)
    toast('Saved', 'success')
    await loadObjects()
    if (tab.isNew) {
      const n = nameFrom(body)
      if (n) updateTab(tab.id, { isNew: false, name: n, title: n, objKind: tab.objKind === 'matview' ? 'matview' : /create\s+(or\s+replace\s+)?procedure/i.test(body) ? 'procedure' : tab.objKind })
    }
    setOrig(body)
    setTimeout(bumpPending)
    return true
  }

  useEffect(() => {
    registerTabApi(tab.id, { pendingCount: () => (textRef.current !== orig && !readOnly ? 1 : 0), previewSql: () => [textRef.current], commit: save, discard: () => setText(orig) })
    return () => registerTabApi(tab.id, null)
  }, [orig, readOnly])

  useCommands(`ddl-${tab.id}`, { 'edit.commit': () => { void save() }, 'conn.reloadTab': () => void load() })

  return (
    <div className="col grow" style={{ minHeight: 0 }} onFocusCapture={() => focusScope(`ddl-${tab.id}`)}>
      <div className="runbar">
        <b style={{ fontSize: 'var(--fs-sm)' }}>{tab.isNew ? `New ${tab.objKind}` : `${tab.objKind} ${tab.schema ? tab.schema + '.' : ''}${tab.name}`}</b>
        {readOnly && <span className="faint" style={{ fontSize: 'var(--fs-xs)' }}>Materialized views can't be edited in place. Drop and recreate them from a query tab.</span>}
        <span className="grow" />
        {tab.objKind === 'matview' && !tab.isNew && <button className="btn sm" onClick={() => newQueryTab(`REFRESH MATERIALIZED VIEW "${tab.schema}"."${tab.name}";`)}>Refresh…</button>}
        {(tab.objKind === 'function' || tab.objKind === 'procedure') && !tab.isNew && (
          <button className="btn sm" onClick={() => newQueryTab(tab.objKind === 'procedure' ? `CALL ${d === 'mysql' ? '`' + tab.name + '`' : `"${tab.schema}"."${tab.name}"`}();` : `SELECT ${d === 'mysql' ? '`' + tab.name + '`' : `"${tab.schema}"."${tab.name}"`}();`)}>Run in editor</button>
        )}
        <button className="btn sm" onClick={() => setText(orig)} disabled={text === orig}>Revert</button>
        <button className="btn sm primary" onClick={() => void save()} disabled={readOnly || text === orig}>Save ⌘S</button>
      </div>
      {error && <div className="danger-text selectable" style={{ padding: 'var(--sp-4)', borderBottom: '1px solid var(--border)', whiteSpace: 'pre-wrap', fontSize: 'var(--fs-sm)' }}>{error}</div>}
      <CodeEditor value={text} onChange={(v) => { setText(v); if (tab.preview) updateTab(tab.id, { preview: false }); setTimeout(bumpPending) }} options={{ dialect: d, readOnly }} ariaLabel={`Definition of ${tab.name ?? 'new object'}`} />
    </div>
  )
}

