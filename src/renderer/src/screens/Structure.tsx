// Structure + Index views for a table, and the "New table" editor. Every change is staged as DDL until commit.
import { type MutableRefObject, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type { Column, ForeignKey, Index, Trigger } from '@shared/types'
import {
  type ColumnDraft, addColumnSql, alterColumnSql, dropColumnSql, setPrimaryKeySql, addForeignKeySql, dropForeignKeySql,
  createIndexSql, dropIndexSql, renameTableSql, createTableSql, TYPE_LIST, DEFAULT_PRESETS, FK_ACTIONS
} from '@shared/sqlgen'
import { call, errText, fail, toast, uid } from '../lib/api'
import { useWs, guard, busy, updateTab, loadObjects, bumpPending, newQueryTab, type Tab } from '../lib/ws'
import { Grid, type GridColumn } from '../components/Grid'
import { Icon } from '../components/Icon'
import { Modal, menuAt, openMenu } from '../components/ui'

export interface StructureApi { pendingCount: () => number; previewSql: () => string[]; commit: () => Promise<boolean>; discard: () => void; add: () => void; focusSearch: () => void }

interface ColRow extends ColumnDraft { key: string; orig?: Column; deleted?: boolean }
interface IdxRow { key: string; name: string; columns: string; unique: boolean; condition: string; orig?: Index; deleted?: boolean }

const toDraft = (c: Column): ColRow => ({ key: c.name, name: c.name, type: c.type, nullable: c.nullable, default: c.default, comment: c.comment ?? null, orig: c })
const same = (a: ColumnDraft, b: ColumnDraft): boolean => a.name === b.name && a.type === b.type && a.nullable === b.nullable && (a.default ?? null) === (b.default ?? null) && (a.comment ?? '') === (b.comment ?? '')

export function Structure({ tab, view, columns, fks, apiRef, onCommitted }: { tab: Tab; view: 'structure' | 'index'; columns: Column[]; fks: ForeignKey[]; apiRef: MutableRefObject<StructureApi | null>; onCommitted: () => Promise<void> }): ReactNode {
  const s = useWs()
  const d = s.dialect!
  const schema = tab.schema ?? s.schema ?? ''
  const [tableName, setTableName] = useState(tab.name ?? '')
  const [rows, setRows] = useState<ColRow[]>([])
  const [pk, setPk] = useState<string[]>([])
  const [fkAdd, setFkAdd] = useState<ForeignKey[]>([])
  const [fkDrop, setFkDrop] = useState<string[]>([])
  const [idx, setIdx] = useState<IdxRow[]>([])
  const [triggers, setTriggers] = useState<Trigger[]>([])
  const [trigDrop, setTrigDrop] = useState<string[]>([])
  const [q, setQ] = useState('')
  const [fkEdit, setFkEdit] = useState<{ column: string } | null>(null)
  const [ddl, setDdl] = useState<string | null>(null)
  const [showTriggers, setShowTriggers] = useState(false)
  const search = useRef<HTMLInputElement>(null)
  const origPk = useMemo(() => columns.filter((c) => c.pk).map((c) => c.name), [columns])

  const reset = async (): Promise<void> => {
    setRows(tab.isNew ? [{ key: uid(), name: 'id', type: d === 'postgres' ? 'bigserial' : d === 'mysql' ? 'bigint' : 'INTEGER', nullable: false, default: null }] : columns.map(toDraft))
    setPk(tab.isNew ? ['id'] : origPk)
    setFkAdd([]); setFkDrop([]); setTrigDrop([])
    setTableName(tab.name ?? '')
    if (!tab.isNew) {
      const ix = await call<Index[]>('db.indexes', s.sessionId, schema, tab.name).catch(() => [])
      setIdx(ix.filter((i) => !i.primary).map((i) => ({ key: i.name, name: i.name, columns: i.columns.join(', '), unique: i.unique, condition: i.condition ?? '', orig: i })))
      setTriggers(await call<Trigger[]>('db.triggers', s.sessionId, schema, tab.name).catch(() => []))
    }
    setTimeout(bumpPending)
  }
  useEffect(() => { void reset() }, [columns])

  const statements = (): string[] => {
    const out: string[] = []
    if (tab.isNew) {
      if (!tableName.trim() || !rows.length) return []
      out.push(createTableSql(d, schema, tableName.trim(), rows.filter((r) => !r.deleted), pk))
      for (const f of fkAdd) out.push(addForeignKeySql(d, schema, tableName.trim(), f))
      for (const i of idx.filter((x) => !x.deleted)) out.push(createIndexSql(d, schema, tableName.trim(), { name: i.name, columns: i.columns.split(',').map((x) => x.trim()).filter(Boolean), unique: i.unique, condition: i.condition }))
      return out
    }
    const t = tab.name!
    const errs: string[] = []
    const tryAdd = (f: () => string | string[]): void => { try { const r = f(); out.push(...(Array.isArray(r) ? r : [r])) } catch (e) { errs.push(errText(e)) } }
    for (const n of fkDrop) tryAdd(() => dropForeignKeySql(d, schema, t, n))
    for (const n of trigDrop) out.push(d === 'mysql' ? `DROP TRIGGER \`${schema}\`.\`${n}\`;` : d === 'postgres' ? `DROP TRIGGER "${n}" ON "${schema}"."${t}";` : `DROP TRIGGER "${n}";`)
    for (const i of idx) {
      if (i.orig && i.deleted) tryAdd(() => dropIndexSql(d, schema, t, i.orig!.name))
      else if (i.orig && (i.name !== i.orig.name || i.columns !== i.orig.columns.join(', ') || i.unique !== i.orig.unique || i.condition !== (i.orig.condition ?? ''))) {
        tryAdd(() => dropIndexSql(d, schema, t, i.orig!.name))
        tryAdd(() => createIndexSql(d, schema, t, { name: i.name, columns: i.columns.split(',').map((x) => x.trim()), unique: i.unique, condition: i.condition }))
      } else if (!i.orig && !i.deleted && i.name && i.columns) tryAdd(() => createIndexSql(d, schema, t, { name: i.name, columns: i.columns.split(',').map((x) => x.trim()), unique: i.unique, condition: i.condition }))
    }
    for (const r of rows) {
      if (r.orig && r.deleted) out.push(dropColumnSql(d, schema, t, r.orig.name))
      else if (r.orig && !same(toDraft(r.orig), r)) tryAdd(() => alterColumnSql(d, schema, t, toDraft(r.orig!), r))
      else if (!r.orig && !r.deleted && r.name) out.push(...addColumnSql(d, schema, t, r))
    }
    if (pk.join() !== origPk.join()) tryAdd(() => setPrimaryKeySql(d, schema, t, pk, origPk.length > 0))
    for (const f of fkAdd) tryAdd(() => addForeignKeySql(d, schema, t, f))
    if (tableName.trim() && tableName.trim() !== t) out.push(renameTableSql(d, schema, t, tableName.trim()))
    if (errs.length) out.unshift(...errs.map((e) => `-- cannot apply: ${e}`))
    return out
  }

  const pendingCount = (): number => statements().length

  apiRef.current = {
    pendingCount: () => (tab.isNew ? (tableName.trim() ? 1 : 0) : pendingCount()),
    previewSql: statements,
    discard: () => void reset(),
    add: () => (view === 'index' ? addIndex() : addColumn()),
    focusSearch: () => search.current?.focus(),
    commit: async () => {
      const stmts = statements()
      const bad = stmts.find((x) => x.startsWith('-- cannot apply'))
      if (bad) { toast(bad.replace('-- cannot apply: ', ''), 'error'); return false }
      if (tab.isNew && !tableName.trim()) { toast('Give the new table a name first.', 'error'); return false }
      if (!stmts.length) return true
      if (!(await guard(stmts))) return false
      const r = await busy(call<{ ok: boolean; index?: number; error?: string }>('db.commit', s.sessionId, stmts))
      if (!r.ok) { toast(`Failed at statement ${(r.index ?? 0) + 1}:\n${r.error}`, 'error', 12000); return false }
      toast('Structure updated', 'success')
      const newName = tableName.trim()
      if (tab.isNew || newName !== tab.name) {
        updateTab(tab.id, { isNew: false, name: newName, title: newName, view: tab.isNew ? 'data' : tab.view })
        await loadObjects()
      }
      await onCommitted()
      return true
    }
  }

  const changed = (): void => { setTimeout(bumpPending) }
  const addColumn = (): void => { setRows((r) => [...r, { key: uid(), name: `column_${r.length + 1}`, type: TYPE_LIST[d][d === 'sqlite' ? 2 : 4] ?? 'text', nullable: true, default: null }]); changed() }
  const addIndex = (): void => { setIdx((x) => [...x, { key: uid(), name: `${tab.name || tableName || 'table'}_idx_${x.length + 1}`, columns: '', unique: false, condition: '' }]); changed() }
  const patchRow = (i: number, p: Partial<ColRow>): void => { setRows((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x))); changed() }
  const patchIdx = (i: number, p: Partial<IdxRow>): void => { setIdx((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x))); changed() }

  const visibleRows = rows.map((r, i) => ({ r, i })).filter(({ r }) => !q || r.name.toLowerCase().includes(q.toLowerCase()))
  const fkLabel = (col: string): string => {
    const f = [...fks.filter((x) => !fkDrop.includes(x.name)), ...fkAdd].find((x) => x.columns.length === 1 && x.columns[0] === col)
    return f ? `→ ${f.refTable}(${f.refColumns.join(', ')})` : ''
  }

  const structCols: GridColumn[] = [
    { name: 'column_name' }, { name: 'data_type' }, { name: 'is_nullable' }, { name: 'column_default' }, { name: 'foreign_key', readOnly: true }, { name: 'comment', readOnly: d === 'sqlite' }, { name: 'extra', readOnly: true }
  ]
  const structData = visibleRows.map(({ r }) => [r.name, r.type, r.nullable ? 'YES' : 'NO', r.default, fkLabel(r.name), r.comment ?? null, r.orig?.extra ?? null])
  const structPending = {
    edits: new Map(visibleRows.flatMap(({ r }, vi) => {
      if (!r.orig || r.deleted) return []
      const o = toDraft(r.orig)
      const m = new Map<number, string>()
      if (o.name !== r.name) m.set(0, r.name)
      if (o.type !== r.type) m.set(1, r.type)
      if (o.nullable !== r.nullable) m.set(2, r.nullable ? 'YES' : 'NO')
      if ((o.default ?? null) !== (r.default ?? null)) m.set(3, r.default ?? 'NULL')
      if ((o.comment ?? '') !== (r.comment ?? '')) m.set(5, r.comment ?? '')
      return m.size ? [[vi, m]] : []
    })),
    deleted: new Set(visibleRows.flatMap(({ r }, vi) => (r.deleted ? [vi] : []))),
    insertedFrom: visibleRows.findIndex(({ r }) => !r.orig) < 0 ? visibleRows.length : visibleRows.findIndex(({ r }) => !r.orig)
  }

  const editCell = (vi: number, c: number, v: unknown): void => {
    const { i } = visibleRows[vi]
    const val = v === null ? null : String(v)
    if (c === 0) { const old = rows[i].name; patchRow(i, { name: val ?? '' }); if (pk.includes(old)) setPk(pk.map((p) => (p === old ? val ?? '' : p))) }
    if (c === 1) patchRow(i, { type: val ?? '' })
    if (c === 2) patchRow(i, { nullable: !/^(no|false|0|n)$/i.test(val ?? '') })
    if (c === 3) patchRow(i, { default: val === '' || val === null || val === 'NULL' ? null : val })
    if (c === 5) patchRow(i, { comment: val })
  }

  const cellMenuAt = (x: number, y: number, vi: number, c: number): void => {
    const { r, i } = visibleRows[vi]
    if (c === 1) openMenu(TYPE_LIST[d].map((t) => ({ label: t, checked: r.type === t, onClick: () => patchRow(i, { type: t }) })), x, y)
    else if (c === 2) patchRow(i, { nullable: !r.nullable })
    else if (c === 3) openMenu([{ label: 'No default', onClick: () => patchRow(i, { default: null }) }, ...DEFAULT_PRESETS[d].map((p) => ({ label: p, onClick: () => patchRow(i, { default: p }) }))], x, y)
    else if (c === 4) {
      if (d === 'sqlite') { toast('SQLite cannot add or drop foreign keys on an existing table.'); return }
      const existing = [...fks.filter((f) => !fkDrop.includes(f.name)), ...fkAdd].filter((f) => f.columns.includes(r.name))
      openMenu([
        { label: `Create foreign key on ${r.name}…`, onClick: () => setFkEdit({ column: r.name }) },
        ...existing.map((f) => ({ label: `Drop ${f.name || '→ ' + f.refTable}`, onClick: () => { if (fkAdd.includes(f)) setFkAdd(fkAdd.filter((x) => x !== f)); else setFkDrop([...fkDrop, f.name]); changed() } }))
      ], x, y)
    }
  }

  if (view === 'index') {
    const idxCols: GridColumn[] = [{ name: 'index_name' }, { name: 'columns' }, { name: 'is_unique' }, { name: d === 'mysql' ? 'type' : 'condition', readOnly: d === 'mysql' }]
    return (
      <div className="col grow" style={{ minHeight: 0 }}>
        <div className="row" style={{ padding: 'var(--sp-3) var(--sp-4)', borderBottom: '1px solid var(--border)' }}>
          <button className="btn sm" onClick={addIndex}><Icon name="plus" size={11} /> Index</button>
          <span className="faint" style={{ fontSize: 'var(--fs-xs)' }}>Double-click a cell to edit. Columns are comma-separated. Primary keys are on the Structure view.</span>
        </div>
        <Grid
          columns={idxCols}
          rows={idx.map((i) => [i.name, i.columns, i.unique ? 'TRUE' : 'FALSE', d === 'mysql' ? i.orig?.type ?? '' : i.condition || null])}
          editable
          pending={{ edits: new Map(), deleted: new Set(idx.flatMap((x, k) => (x.deleted ? [k] : []))), insertedFrom: idx.findIndex((x) => !x.orig) < 0 ? idx.length : idx.findIndex((x) => !x.orig) }}
          onEdit={(r, c, v) => {
            const val = v === null ? '' : String(v)
            if (c === 0) patchIdx(r, { name: val })
            if (c === 1) patchIdx(r, { columns: val })
            if (c === 2) patchIdx(r, { unique: /^(t|true|1|y|yes)$/i.test(val) })
            if (c === 3) patchIdx(r, { condition: val })
          }}
          onDoubleClickCell={(r, c) => { if (c === 2) { patchIdx(r, { unique: !idx[r].unique }); return true } return false }}
          onKey={(e, sel) => { if ((e.key === 'Backspace' || e.key === 'Delete') && sel) { for (let r = sel.r0; r <= sel.r1; r++) patchIdx(r, { deleted: !idx[r].deleted }); return true } return false }}
          onCellMenu={(e, r, c) => menuAt(e, [
            ...(c === 1 ? [{ label: 'Add column', submenu: columns.map((col) => ({ label: col.name, onClick: () => patchIdx(r, { columns: [...idx[r].columns.split(',').map((x) => x.trim()).filter(Boolean), col.name].join(', ') }) })) }] : []),
            { label: idx[r].deleted ? 'Restore' : 'Delete', onClick: () => patchIdx(r, { deleted: !idx[r].deleted }) }
          ])}
          empty="No indexes besides the primary key."
        />
      </div>
    )
  }

  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <div className="row" style={{ padding: 'var(--sp-3) var(--sp-4)', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <label className="row" style={{ fontSize: 'var(--fs-sm)' }}>Name <input className="input sm mono" style={{ width: 180 }} value={tableName} autoFocus={tab.isNew} placeholder="table_name" onChange={(e) => { setTableName(e.target.value); changed() }} /></label>
        <label className="row" style={{ fontSize: 'var(--fs-sm)' }} title="Comma-separated column names">Primary key
          <input className="input sm mono" style={{ width: 200 }} disabled={d === 'sqlite' && !tab.isNew} value={pk.join(', ')} onChange={(e) => { setPk(e.target.value.split(',').map((x) => x.trim()).filter(Boolean)); changed() }} />
        </label>
        <button className="btn sm" onClick={addColumn}><Icon name="plus" size={11} /> Column</button>
        <span className="grow" />
        <input ref={search} className="input sm" placeholder="Search columns" aria-label="Search columns" value={q} onChange={(e) => setQ(e.target.value)} />
        {!tab.isNew && <button className="btn sm" onClick={() => setShowTriggers(true)}>Triggers{triggers.length ? ` (${triggers.length})` : ''}</button>}
        {!tab.isNew && <button className="btn sm" onClick={async () => setDdl(await call<string>('db.ddl', s.sessionId, schema, tab.name, tab.objKind ?? 'table').catch((e) => `-- ${errText(e)}`))}>DDL</button>}
      </div>
      <Grid
        columns={structCols}
        rows={structData}
        pending={structPending}
        editable={tab.objKind !== 'view' && tab.objKind !== 'matview'}
        onEdit={editCell}
        onDoubleClickCell={(vi, c) => {
          if (c !== 2 && c !== 4) return false
          const cell = document.querySelector('.grid-cell.focus')?.getBoundingClientRect()
          cellMenuAt(cell?.left ?? 300, cell?.bottom ?? 200, vi, c)
          return true
        }}
        onKey={(e, sel) => {
          if ((e.key === 'Backspace' || e.key === 'Delete') && sel) { for (let v = sel.r0; v <= sel.r1; v++) { const { r, i } = visibleRows[v]; if (r.orig) patchRow(i, { deleted: !r.deleted }); else setRows((x) => x.filter((_, j) => j !== i)) } return true }
          if (e.key === 'Enter' && e.altKey && sel) { const cell = document.querySelector('.grid-cell.focus')?.getBoundingClientRect(); cellMenuAt(cell?.left ?? 300, cell?.bottom ?? 200, sel.r1, sel.c1); return true }
          return false
        }}
        onCellMenu={(e, vi) => menuAt(e, [
          { label: 'Data type', submenu: TYPE_LIST[d].map((t) => ({ label: t, onClick: () => patchRow(visibleRows[vi].i, { type: t }) })) },
          { label: 'Default', submenu: [{ label: 'No default', onClick: () => patchRow(visibleRows[vi].i, { default: null }) }, ...DEFAULT_PRESETS[d].map((p) => ({ label: p, onClick: () => patchRow(visibleRows[vi].i, { default: p }) }))] },
          { label: visibleRows[vi].r.nullable ? 'Make NOT NULL' : 'Allow NULL', onClick: () => patchRow(visibleRows[vi].i, { nullable: !visibleRows[vi].r.nullable }) },
          { label: pk.includes(visibleRows[vi].r.name) ? 'Remove from primary key' : 'Add to primary key', disabled: d === 'sqlite' && !tab.isNew, onClick: () => { const n = visibleRows[vi].r.name; setPk(pk.includes(n) ? pk.filter((x) => x !== n) : [...pk, n]); changed() } },
          ...(d !== 'sqlite' || tab.isNew ? [{ label: 'Foreign key…', onClick: () => setFkEdit({ column: visibleRows[vi].r.name }) }] : []),
          { sep: true },
          { label: 'Copy column name', onClick: () => void navigator.clipboard.writeText(visibleRows[vi].r.name) },
          { label: 'New column', onClick: addColumn },
          { label: visibleRows[vi].r.deleted ? 'Restore' : 'Delete column', danger: true, onClick: () => { const { r, i } = visibleRows[vi]; if (r.orig) patchRow(i, { deleted: !r.deleted }); else setRows((x) => x.filter((_, j) => j !== i)) } },
        ])}
        empty={q ? 'No column matches.' : 'No columns yet. Press ⌘I to add one.'}
      />
      {fkEdit && <FkEditor dialect={d} column={fkEdit.column} schema={schema} onClose={() => setFkEdit(null)} onSave={(f) => { setFkAdd([...fkAdd, f]); setFkEdit(null); changed() }} />}
      {ddl !== null && (
        <Modal title="Table definition" onClose={() => setDdl(null)} width={720} footer={<><button className="btn" onClick={() => navigator.clipboard.writeText(ddl)}>Copy</button><button className="btn" onClick={() => { newQueryTab(ddl); setDdl(null) }}>Open in editor</button><button className="btn primary" onClick={() => setDdl(null)}>Close</button></>}>
          <pre className="code" style={{ maxHeight: '60vh' }}>{ddl}</pre>
        </Modal>
      )}
      {showTriggers && (
        <Modal title={`Triggers on ${tab.name}`} onClose={() => setShowTriggers(false)} width={720} footer={<>
          <button className="btn" style={{ marginRight: 'auto' }} onClick={() => { newQueryTab(triggerTemplate(d, schema, tab.name!)); setShowTriggers(false) }}>New trigger…</button>
          <button className="btn primary" onClick={() => setShowTriggers(false)}>Done</button>
        </>}>
          {triggers.length === 0 ? <div className="empty">No triggers.</div> : triggers.map((t) => (
            <div key={t.name} className="col" style={{ gap: 'var(--sp-2)', opacity: trigDrop.includes(t.name) ? 0.5 : 1 }}>
              <div className="row"><b>{t.name}</b><span className="faint">{t.timing} {t.event}</span><span className="grow" />
                <button className="btn sm" onClick={() => newQueryTab(t.statement)}>Edit as SQL</button>
                <button className="btn sm" onClick={() => { setTrigDrop(trigDrop.includes(t.name) ? trigDrop.filter((x) => x !== t.name) : [...trigDrop, t.name]); changed() }}>{trigDrop.includes(t.name) ? 'Keep' : 'Drop'}</button>
              </div>
              <pre className="code" style={{ maxHeight: 160 }}>{t.statement}</pre>
            </div>
          ))}
        </Modal>
      )}
    </div>
  )
}

function triggerTemplate(d: string, schema: string, table: string): string {
  if (d === 'postgres') return `CREATE OR REPLACE FUNCTION "${schema}".${table}_trigger_fn() RETURNS trigger AS $$\nBEGIN\n  -- NEW / OLD are available here\n  RETURN NEW;\nEND;\n$$ LANGUAGE plpgsql;\n\nCREATE TRIGGER ${table}_trigger\nBEFORE INSERT OR UPDATE ON "${schema}"."${table}"\nFOR EACH ROW EXECUTE FUNCTION "${schema}".${table}_trigger_fn();`
  if (d === 'mysql') return `CREATE TRIGGER \`${table}_before_insert\`\nBEFORE INSERT ON \`${table}\`\nFOR EACH ROW\nSET NEW.created_at = NOW();`
  return `CREATE TRIGGER ${table}_after_insert\nAFTER INSERT ON "${table}"\nBEGIN\n  SELECT 1;\nEND;`
}

function FkEditor({ dialect, column, schema, onClose, onSave }: { dialect: string; column: string; schema: string; onClose: () => void; onSave: (f: ForeignKey) => void }): ReactNode {
  const s = useWs()
  const tables = s.objects.filter((o) => o.kind === 'table')
  const [refTable, setRefTable] = useState(tables[0]?.name ?? '')
  const [refCols, setRefCols] = useState<Column[]>([])
  const [refCol, setRefCol] = useState('')
  const [onUpdate, setOnUpdate] = useState('NO ACTION')
  const [onDelete, setOnDelete] = useState('NO ACTION')
  const [name, setName] = useState(`fk_${column}`)
  useEffect(() => {
    if (!refTable) return
    void call<Column[]>('db.columns', s.sessionId, schema, refTable).then((c) => { setRefCols(c); setRefCol(c.find((x) => x.pk)?.name ?? c[0]?.name ?? '') }).catch(fail)
  }, [refTable])
  void dialect
  return (
    <Modal title={`Foreign key on ${column}`} onClose={onClose} width={440} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!refTable || !refCol} onClick={() => onSave({ name, columns: [column], refSchema: schema, refTable, refColumns: [refCol], onUpdate, onDelete })}>OK</button></>}>
      <div className="field"><label htmlFor="fk-name">Name</label><input id="fk-name" className="input mono" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="field"><label htmlFor="fk-table">Referenced table</label><select id="fk-table" className="select" value={refTable} onChange={(e) => setRefTable(e.target.value)}>{tables.map((t) => <option key={t.name}>{t.name}</option>)}</select></div>
      <div className="field"><label htmlFor="fk-col">Referenced column</label><select id="fk-col" className="select" value={refCol} onChange={(e) => setRefCol(e.target.value)}>{refCols.map((c) => <option key={c.name}>{c.name}</option>)}</select></div>
      <div className="field"><label htmlFor="fk-upd">On update</label><select id="fk-upd" className="select" value={onUpdate} onChange={(e) => setOnUpdate(e.target.value)}>{FK_ACTIONS.map((a) => <option key={a}>{a}</option>)}</select></div>
      <div className="field"><label htmlFor="fk-del">On delete</label><select id="fk-del" className="select" value={onDelete} onChange={(e) => setOnDelete(e.target.value)}>{FK_ACTIONS.map((a) => <option key={a}>{a}</option>)}</select></div>
    </Modal>
  )
}

