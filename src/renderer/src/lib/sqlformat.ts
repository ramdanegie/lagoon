import { format } from 'sql-formatter'
import type { Dialect } from '@shared/types'
import { setting } from './api'

const LANG = { postgres: 'postgresql', mysql: 'mysql', sqlite: 'sqlite' } as const

/** Beautify with the user's formatting settings. Throws with a readable message when the SQL can't be parsed. */
export function beautify(sql: string, dialect: Dialect = 'postgres'): string {
  return format(sql, {
    language: LANG[dialect],
    keywordCase: setting('format.uppercase', true) ? 'upper' : 'preserve',
    useTabs: setting('format.indent', 'spaces') === 'tab',
    tabWidth: setting('format.width', 2),
    indentStyle: setting('format.type', 'standard') as 'standard' | 'tabularLeft' | 'tabularRight'
  })
}

/** Collapse whitespace outside quotes and drop line comments: one-line SQL. */
export function uglify(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < sql.length && !(sql[j] === c && sql[j + 1] !== c)) j += sql[j] === c ? 2 : 1
      out += sql.slice(i, j + 1)
      i = j + 1
    } else if (c === '-' && sql[i + 1] === '-') {
      const e = sql.indexOf('\n', i)
      i = e < 0 ? sql.length : e
    } else if (/\s/.test(c)) {
      if (!out.endsWith(' ')) out += ' '
      i++
    } else { out += c; i++ }
  }
  return out.trim()
}
