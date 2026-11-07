// Named table view profiles, stored in settings under `profiles.<connectionId>` as { tableKey: TableProfile[] }.
// Pure helpers (no runtime imports) so `node --test` can load them.
import type { Filter, SortSpec } from '@shared/types'

export interface TableProfile {
  name: string
  filters: Filter[]
  applied: Filter[]
  join: 'AND' | 'OR'
  sort: SortSpec[]
  visible: string[] | null
  widths: Record<string, number>
}
export type ProfileMap = Record<string, TableProfile[]>

export const profilesKey = (connectionId: string): string => `profiles.${connectionId}`

/** Add a profile, or replace the one with the same name in place. */
export function saveProfile(m: ProfileMap, table: string, p: TableProfile): ProfileMap {
  const list = m[table] ?? []
  const i = list.findIndex((x) => x.name === p.name)
  return { ...m, [table]: i < 0 ? [...list, p] : list.map((x, j) => (j === i ? p : x)) }
}

/** Rename; a profile already using the new name is replaced. */
export function renameProfile(m: ProfileMap, table: string, from: string, to: string): ProfileMap {
  if (!to || to === from) return m
  return { ...m, [table]: (m[table] ?? []).filter((x) => x.name !== to).map((x) => (x.name === from ? { ...x, name: to } : x)) }
}

export function deleteProfile(m: ProfileMap, table: string, name: string): ProfileMap {
  const list = (m[table] ?? []).filter((x) => x.name !== name)
  const next = { ...m }
  if (list.length) next[table] = list
  else delete next[table]
  return next
}
