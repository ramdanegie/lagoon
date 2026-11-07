// Find & replace matching for loaded grid cells. Pure so `node --test` can load it.
export interface FindOpts { find: string; matchCase: boolean; wholeCell: boolean; regex: boolean }

/** Global regex for the options, or null when the pattern is empty or invalid. */
export function findRegex(o: FindOpts): RegExp | null {
  if (!o.find) return null
  const src = o.regex ? o.find : o.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try {
    return new RegExp(o.wholeCell ? `^(?:${src})$` : src, o.matchCase ? 'g' : 'gi')
  } catch {
    return null
  }
}

export const cellMatches = (re: RegExp, text: string): boolean => {
  re.lastIndex = 0
  return re.test(text)
}

/** Replace every match; `$1`-style references only apply in regex mode. */
export const replaceCell = (re: RegExp, text: string, replacement: string, regex: boolean): string =>
  regex ? text.replace(re, replacement) : text.replace(re, () => replacement)
