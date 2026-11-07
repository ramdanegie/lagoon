// Example Lagoon plugin: builds SQL text from grid rows and runs a read-only query.

function quoteIdent(name) {
  return context.dialect() === 'mysql' ? '`' + String(name).replace(/`/g, '``') + '`' : '"' + String(name).replace(/"/g, '""') + '"'
}

function literal(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number' || typeof v === 'bigint') return String(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  if (context.dialect() === 'mysql') s = s.replace(/\\/g, '\\\\')
  return "'" + s.replace(/'/g, "''") + "'"
}

function tableName(t) {
  return (t.schema ? quoteIdent(t.schema) + '.' : '') + quoteIdent(t.name)
}

function copyUpdate() {
  const table = context.selectedTable()
  const rows = context.selectedRows()
  if (!table || !rows.length) throw new Error('Right-click a row in a table first')
  const sql = rows.map((row) => {
    const cols = Object.keys(row)
    // Guess the key: an "id" column, otherwise the first column.
    const key = cols.find((c) => c.toLowerCase() === 'id') || cols[0]
    const set = cols.filter((c) => c !== key).map((c) => quoteIdent(c) + ' = ' + literal(row[c])).join(', ')
    return 'UPDATE ' + tableName(table) + ' SET ' + set + ' WHERE ' + quoteIdent(key) + ' = ' + literal(row[key]) + ';'
  })
  SystemService.insertToClipboard(sql.join('\n'))
  SystemService.notify('Copied', sql.length + ' UPDATE statement' + (sql.length > 1 ? 's' : ''))
}

async function countRows() {
  const item = context.currentItem()
  if (!item) throw new Error('Right-click a table in the sidebar first')
  const r = await db.query('SELECT COUNT(*) AS n FROM ' + tableName(item))
  SystemService.notify(item.name, Number(r.rows[0].n).toLocaleString() + ' rows')
}
