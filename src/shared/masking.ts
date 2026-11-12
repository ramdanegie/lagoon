// Data masking for exports and transfers: rules match column names (glob, any case) and rewrite their values on the
// way out. The source data is never changed. Tested in test/masking.test.ts.

export type MaskMethod = 'email' | 'keepLast' | 'digits' | 'hash' | 'fixed' | 'null'
export interface MaskRule { column: string; method: MaskMethod; arg?: string }

export const MASK_METHODS: { id: MaskMethod; label: string; arg?: string }[] = [
  { id: 'email', label: 'Hide email (a***@domain)' },
  { id: 'keepLast', label: 'Keep the last characters', arg: 'How many' },
  { id: 'digits', label: 'Random digits, same format' },
  { id: 'hash', label: 'Pseudonym (same value, same result)' },
  { id: 'fixed', label: 'Replace with text', arg: 'Text' },
  { id: 'null', label: 'NULL' }
]

export const MASK_PRESETS: MaskRule[] = [
  { column: '*email*', method: 'email' },
  { column: '*phone*', method: 'digits' },
  { column: '*password*', method: 'null' },
  { column: '*token*', method: 'null' },
  { column: '*card*', method: 'keepLast', arg: '4' },
  { column: '*address*', method: 'fixed', arg: 'redacted' }
]

const globRe = (g: string): RegExp => new RegExp('^' + g.trim().split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i')

/** 53-bit string hash (cyrb53). Not cryptographic: short secrets such as PINs can be guessed, so mask those with NULL. */
function hash53(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

export function maskValue(v: unknown, r: MaskRule, salt = ''): unknown {
  if (v === null || v === undefined || r.method === 'null') return null
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  switch (r.method) {
    case 'email': {
      const at = s.lastIndexOf('@')
      return at > 0 ? `${s[0]}***${s.slice(at)}` : '***'
    }
    case 'keepLast': {
      const n = Math.max(0, Math.floor(Number(r.arg) || 0))
      return '*'.repeat(Math.max(0, s.length - n)) + (n ? s.slice(-n) : '')
    }
    case 'digits': return s.replace(/\d/g, () => String(Math.floor(Math.random() * 10)))
    case 'hash': return hash53(salt + s)
    case 'fixed': return r.arg ?? ''
  }
}

/** A row rewriter for these columns, or null when no rule applies. The first matching rule wins per column. */
export function masker(columns: string[], rules: MaskRule[], salt = ''): ((row: unknown[]) => unknown[]) | null {
  const res = rules.filter((r) => r.column.trim()).map((r) => ({ r, re: globRe(r.column) }))
  const per = columns.map((c) => res.find((x) => x.re.test(c))?.r)
  if (!per.some(Boolean)) return null
  return (row) => row.map((v, i) => (per[i] ? maskValue(v, per[i]!, salt) : v))
}

/** Column names a rule set would mask, for previews. */
export const maskedColumns = (columns: string[], rules: MaskRule[]): string[] => {
  const res = rules.filter((r) => r.column.trim()).map((r) => globRe(r.column))
  return columns.filter((c) => res.some((re) => re.test(c)))
}
