import type { ReactNode } from 'react'

// Simple stroke icons drawn for this app (16px grid).
const P: Record<string, ReactNode> = {
  table: <><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M2 6.5h12M6 6.5V13" /></>,
  view: <><rect x="2" y="3" width="12" height="10" rx="1.5" /><circle cx="8" cy="8" r="2" /></>,
  matview: <><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M5 10l2-3 2 2 2-3" /></>,
  function: <path d="M10 2.5c-2 0-2.5 1-2.8 3L6.4 11c-.3 2-.9 2.5-2.4 2.5M4.5 6.5h6" />,
  procedure: <><path d="M4 3h8v10H4z" /><path d="M6 6h4M6 8.5h4M6 11h2" /></>,
  sequence: <path d="M3 4h2v8M8 12V4l3 0v4H8M13 4v8" />,
  collection: <><ellipse cx="8" cy="4" rx="5" ry="1.8" /><path d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4M3 8c0 1 2.2 1.8 5 1.8S13 9 13 8" /></>,
  key: <><circle cx="5.5" cy="10.5" r="2.5" /><path d="M7.3 8.7L13 3M11 5l1.5 1.5M9.5 6.5L11 8" /></>,
  db: <><ellipse cx="8" cy="3.8" rx="5" ry="1.8" /><path d="M3 3.8v8.4c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V3.8M3 8c0 1 2.2 1.8 5 1.8S13 9 13 8" /></>,
  plus: <path d="M8 3v10M3 8h10" />,
  minus: <path d="M3 8h10" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  chevronDown: <path d="M4 6l4 4 4-4" />,
  chevronRight: <path d="M6 4l4 4-4 4" />,
  chevronLeft: <path d="M10 4L6 8l4 4" />,
  search: <><circle cx="7" cy="7" r="4" /><path d="M10 10l3.5 3.5" /></>,
  refresh: <path d="M13 8a5 5 0 1 1-1.5-3.5M13 3v3h-3" />,
  lock: <><rect x="3.5" y="7" width="9" height="6.5" rx="1" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></>,
  unlock: <><rect x="3.5" y="7" width="9" height="6.5" rx="1" /><path d="M5.5 7V5a2.5 2.5 0 0 1 4.8-1" /></>,
  play: <path d="M5 3.5v9l7-4.5z" fill="currentColor" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />,
  filter: <path d="M2.5 3.5h11L9.2 8.5v4l-2.4 1v-5z" />,
  columns: <><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M6 3v10M10 3v10" /></>,
  sidebarLeft: <><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M6 3v10" /></>,
  sidebarRight: <><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M10 3v10" /></>,
  console: <><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M2 10h12" /></>,
  gear: <><path d="M8 1.8l1.2 1.4 1.8-.4.6 1.8 1.8.6-.4 1.8 1.4 1.2-1.4 1.2.4 1.8-1.8.6-.6 1.8-1.8-.4L8 14.2l-1.2-1.4-1.8.4-.6-1.8-1.8-.6.4-1.8L1.8 8l1.4-1.2-.4-1.8 1.8-.6.6-1.8 1.8.4z" /><circle cx="8" cy="8" r="2.2" /></>,
  plug: <path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3" />,
  eye: <><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></>,
  check: <path d="M3 8.5l3 3 7-7" />,
  arrowRight: <path d="M3 8h9M9 5l3 3-3 3" />,
  bell: <path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3zM6.5 14h3" />,
  chart: <path d="M3 13V3M3 13h10M6 11V8M9 11V5M12 11V7" />,
  user: <><circle cx="8" cy="5.5" r="2.5" /><path d="M3 13.5c.6-2.5 2.6-4 5-4s4.4 1.5 5 4" /></>,
  file: <><path d="M4 2h5l3 3v9H4z" /><path d="M9 2v3h3" /></>,
  sql: <><path d="M4 2h5l3 3v9H4z" /><path d="M6 9h4M6 11.5h3" /></>,
  folder: <path d="M2 4.5h4l1.5 1.5H14v7H2z" />,
  history: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></>,
  star: <path d="M8 2.5l1.7 3.5 3.8.5-2.8 2.6.7 3.8L8 11l-3.4 1.9.7-3.8-2.8-2.6 3.8-.5z" />,
  more: <><circle cx="4" cy="8" r=".8" fill="currentColor" /><circle cx="8" cy="8" r=".8" fill="currentColor" /><circle cx="12" cy="8" r=".8" fill="currentColor" /></>,
  diagram: <><rect x="2" y="2" width="5" height="4" rx="1" /><rect x="9" y="10" width="5" height="4" rx="1" /><path d="M4.5 6v3.5a1.5 1.5 0 0 0 1.5 1.5H9" /></>,
  pin: <path d="M6 2h4l-.5 4 2 2H4.5l2-2zM8 8v6" />,
  terminal: <><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M5 7l2 1.5L5 10M8.5 10.5H11" /></>,
  arrowFk: <path d="M3 8h8M8 5l3 3-3 3" />,
  upload: <path d="M8 11V3M5 6l3-3 3 3M3 13h10" />,
  download: <path d="M8 3v8M5 8l3 3 3-3M3 13h10" />,
  sun: <><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" /></>,
  moon: <path d="M12.5 10A5.5 5.5 0 0 1 6 3.5a5.5 5.5 0 1 0 6.5 6.5z" />,
  link: <path d="M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.5l-1 1M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l1-1" />
}

export function Icon({ name, size = 14, className, title }: { name: string; size?: number; className?: string; title?: string }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={!title} role={title ? 'img' : undefined} style={{ flex: 'none' }}>
      {title && <title>{title}</title>}
      {P[name] ?? P.file}
    </svg>
  )
}

export const kindIcon = (kind: string): string => ({ table: 'table', view: 'view', matview: 'matview', function: 'function', procedure: 'procedure', sequence: 'sequence', collection: 'collection', key: 'key' })[kind] ?? 'table'
