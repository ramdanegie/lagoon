import { type ReactNode, useEffect, useState } from 'react'
import type { DbObject } from '@shared/types'
import { tip, toast, useCommands } from '../lib/api'
import { useWs, setWs, ws, openTab } from '../lib/ws'
import { pluginMenuItems } from '../lib/plugins'
import { Icon } from '../components/Icon'
import { menuBelow } from '../components/ui'
import { ProcessList } from './ProcessList'
import { PluginManager } from './PluginManager'
import { ImportDialog, ExportDialog, Notifications } from './ImportExport'
import { BackupDialog, RestoreDialog } from './Backup'

type Dlg = { kind: 'process' } | { kind: 'plugins' } | { kind: 'import'; format: 'csv' | 'json' | 'sql'; table?: DbObject } | { kind: 'export'; items: DbObject[] } | { kind: 'backup' } | { kind: 'restore' } | null

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
      {dlg?.kind === 'process' && <ProcessList onClose={() => setDlg(null)} />}
      {dlg?.kind === 'plugins' && <PluginManager onClose={() => setDlg(null)} />}
      {dlg?.kind === 'import' && <ImportDialog kind={dlg.format} table={dlg.table} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'export' && <ExportDialog items={dlg.items} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'backup' && <BackupDialog connections={conn ? [conn] : []} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'restore' && <RestoreDialog connections={conn ? [conn] : []} onClose={() => setDlg(null)} />}
    </>
  )
}
