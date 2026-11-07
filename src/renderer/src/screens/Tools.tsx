import { type ReactNode, Suspense, lazy, useEffect, useState } from 'react'
import type { DbObject } from '@shared/types'
import { tip, toast, useCommands } from '../lib/api'
import { useWs, setWs, ws, openTab } from '../lib/ws'
import { pluginMenuItems } from '../lib/plugins'
import { Icon } from '../components/Icon'
import { menuBelow } from '../components/ui'
import { Notifications } from './ImportExport'

const ProcessList = lazy(() => import('./ProcessList').then((m) => ({ default: m.ProcessList })))
const PluginManager = lazy(() => import('./PluginManager').then((m) => ({ default: m.PluginManager })))
const ImportDialog = lazy(() => import('./ImportExport').then((m) => ({ default: m.ImportDialog })))
const ExportDialog = lazy(() => import('./ImportExport').then((m) => ({ default: m.ExportDialog })))
const BackupDialog = lazy(() => import('./Backup').then((m) => ({ default: m.BackupDialog })))
const RestoreDialog = lazy(() => import('./Backup').then((m) => ({ default: m.RestoreDialog })))
const DataTransfer = lazy(() => import('./DataTransfer').then((m) => ({ default: m.DataTransfer })))
const DataSync = lazy(() => import('./DataSync').then((m) => ({ default: m.DataSync })))
const StructureSync = lazy(() => import('./StructureSync').then((m) => ({ default: m.StructureSync })))
const DataGenerator = lazy(() => import('./DataGenerator').then((m) => ({ default: m.DataGenerator })))
const DataDictionary = lazy(() => import('./DataDictionary').then((m) => ({ default: m.DataDictionary })))

type Dlg = { kind: 'transfer'; items?: DbObject[] } | { kind: 'dataSync' } | { kind: 'structSync' } | { kind: 'generate'; table?: DbObject } | { kind: 'dictionary' } | { kind: 'process' } | { kind: 'plugins' } | { kind: 'import'; format: 'csv' | 'json' | 'sql'; table?: DbObject } | { kind: 'export'; items: DbObject[] } | { kind: 'backup' } | { kind: 'restore' } | null

/** Opens tool windows. Other screens open them through `openTool` (window event) so they stay decoupled. */
export function openTool(detail: Exclude<Dlg, null>): void {
  window.dispatchEvent(new CustomEvent('tool:open', { detail }))
}

export function Tools(): ReactNode {
  const [dlg, setDlg] = useState<Dlg>(null)
  const conn = useWs((s) => s.conn)
  const sql = !!useWs((s) => s.dialect)
  const procOk = conn && ['postgres', 'mysql', 'mariadb'].includes(conn.driver)
  const need = (ok: boolean | undefined, what: string, f: () => void) => () => (ok ? f() : toast(`${what} is not available for this connection.`))

  useEffect(() => {
    const h = (e: Event): void => setDlg((e as CustomEvent).detail)
    window.addEventListener('tool:open', h)
    return () => window.removeEventListener('tool:open', h)
  }, [])

  const actions = {
    'tools.processList': need(procOk, 'Process list', () => setDlg({ kind: 'process' })),
    'tools.users': need(procOk, 'User management', () => openTab({ kind: 'users', title: 'Users' })),
    'tools.diagram': need(sql, 'The diagram', () => openTab({ kind: 'diagram', title: `Diagram · ${ws().schema ?? ''}`, schema: ws().schema })),
    'tools.metrics': need(sql, 'Metrics board', () => openTab({ kind: 'metrics', title: 'Metrics' })),
    'tools.search': need(sql, 'Search in database', () => setWs({ sidebarSearch: true, left: true })),
    'tools.plugins': () => setDlg({ kind: 'plugins' }),
    'tools.transfer': need(sql, 'Data transfer', () => setDlg({ kind: 'transfer', items: ws().selectedObjects.filter((o) => o.kind === 'table') })),
    'tools.dataSync': need(sql, 'Data synchronization', () => setDlg({ kind: 'dataSync' })),
    'tools.structSync': need(sql && ws().dialect !== 'sqlite', 'Structure synchronization', () => setDlg({ kind: 'structSync' })),
    'tools.generate': need(sql, 'Test data generation', () => setDlg({ kind: 'generate', table: ws().selectedObjects.find((o) => o.kind === 'table') })),
    'tools.dictionary': need(sql, 'Data dictionary', () => setDlg({ kind: 'dictionary' })),
    'file.exportTables': need(sql, 'Export', () => setDlg({ kind: 'export', items: ws().selectedObjects.filter((o) => o.kind === 'table' || o.kind === 'view') })),
    'file.importCsv': need(sql, 'Import', () => setDlg({ kind: 'import', format: 'csv' })),
    'file.importJson': need(sql, 'Import', () => setDlg({ kind: 'import', format: 'json' })),
    'file.importSql': need(sql, 'Import', () => setDlg({ kind: 'import', format: 'sql' })),
    'file.backup': () => setDlg({ kind: 'backup' }),
    'file.restore': () => setDlg({ kind: 'restore' })
  }
  useCommands('tools', actions)

  return (
    <>
      <Notifications />
      <button
        className="btn icon ghost"
        data-tour="tools"
        title="Tools"
        aria-label="Tools"
        onClick={(e) =>
          menuBelow(e.currentTarget, [
            { label: 'Process List', kbd: tip('', 'tools.processList').replace(/[() ]/g, ''), disabled: !procOk, onClick: actions['tools.processList'] },
            { label: 'User Management', disabled: !procOk, onClick: actions['tools.users'] },
            { label: 'ER Diagram', disabled: !sql, onClick: actions['tools.diagram'] },
            { label: 'Metrics Board', disabled: !sql, onClick: actions['tools.metrics'] },
            { label: 'Search in Database…', disabled: !sql, onClick: actions['tools.search'] },
            { sep: true },
            { label: 'Data Transfer…', disabled: !sql, onClick: actions['tools.transfer'] },
            { label: 'Data Synchronization…', disabled: !sql, onClick: actions['tools.dataSync'] },
            { label: 'Structure Synchronization…', disabled: !sql || conn?.driver === 'sqlite', onClick: actions['tools.structSync'] },
            { label: 'Generate Test Data…', disabled: !sql, onClick: actions['tools.generate'] },
            { label: 'Data Dictionary…', disabled: !sql, onClick: actions['tools.dictionary'] },
            { sep: true },
            { label: 'Import', disabled: !sql, submenu: [{ label: 'From CSV…', onClick: actions['file.importCsv'] }, { label: 'From JSON…', onClick: actions['file.importJson'] }, { label: 'From SQL Dump…', onClick: actions['file.importSql'] }] },
            { label: 'Export Tables…', disabled: !sql, onClick: actions['file.exportTables'] },
            { label: 'Backup Database…', onClick: actions['file.backup'] },
            { label: 'Restore Database…', onClick: actions['file.restore'] },
            { sep: true },
            { label: 'Manage Plugins…', onClick: actions['tools.plugins'] },
            ...pluginMenuItems('tools', () => ({}))
          ])
        }
      >
        <Icon name="gear" />
      </button>
      <Suspense fallback={null}>
      {dlg?.kind === 'process' && <ProcessList onClose={() => setDlg(null)} />}
      {dlg?.kind === 'plugins' && <PluginManager onClose={() => setDlg(null)} />}
      {dlg?.kind === 'import' && <ImportDialog kind={dlg.format} table={dlg.table} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'export' && <ExportDialog items={dlg.items} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'backup' && <BackupDialog connections={conn ? [conn] : []} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'restore' && <RestoreDialog connections={conn ? [conn] : []} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'transfer' && <DataTransfer items={dlg.items ?? []} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'dataSync' && <DataSync onClose={() => setDlg(null)} />}
      {dlg?.kind === 'structSync' && <StructureSync onClose={() => setDlg(null)} />}
      {dlg?.kind === 'generate' && <DataGenerator table={dlg.table} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'dictionary' && <DataDictionary onClose={() => setDlg(null)} />}
      </Suspense>
    </>
  )
}
