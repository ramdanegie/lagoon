// Example Lagoon plugin: rewrites a JSON cell value. Uses module.exports instead of globals.

function parseCell() {
  const v = context.clickedRowValue()
  if (v !== null && typeof v === 'object') return v
  try {
    return JSON.parse(String(v))
  } catch {
    throw new Error('The cell does not contain valid JSON')
  }
}

module.exports = {
  pretty: () => actions.setCellValue(JSON.stringify(parseCell(), null, 2)),
  compact: () => actions.setCellValue(JSON.stringify(parseCell()))
}
