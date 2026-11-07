// Example Lagoon plugin. Handlers are plain functions; `context`, `actions`,
// `SystemService`, `db` and `crypto.randomUUID()` are globals provided by the host.

function setCell() {
  if (context.clickedColumn() === null) throw new Error('Right-click a cell first')
  actions.setCellValue(crypto.randomUUID())
}

function copy() {
  const id = crypto.randomUUID()
  SystemService.insertToClipboard(id)
  SystemService.notify('UUID copied', id)
}
