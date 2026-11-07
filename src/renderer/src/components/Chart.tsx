// Bar / line / pie chart of a query result. Rows are arrays; numeric strings are coerced.
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { ResultColumn } from '@shared/types'
import { chartData, pieData } from '../lib/metrics'
import '../styles/metrics.css'

// Fixed categorical order from theme tokens (adjacent pairs checked for colour-blind separation in both themes).
const SERIES = ['--accent', '--syn-number', '--syn-keyword', '--syn-string', '--syn-ident']
const INK = ['--fg', '--fg-muted', '--fg-faint', '--grid-line', '--bg-elev', '--border', '--bg-panel']

/** Computed token values (recharts needs concrete colour strings); recomputed when the theme changes. */
function useTokens(): Record<string, string> {
  const read = (): Record<string, string> => {
    const cs = getComputedStyle(document.documentElement)
    return Object.fromEntries([...SERIES, ...INK].map((k) => [k, cs.getPropertyValue(k).trim()]))
  }
  const [t, setT] = useState(read)
  useEffect(() => {
    const mo = new MutationObserver(() => setT(read()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] })
    return () => mo.disconnect()
  }, [])
  return t
}

const fmt = (v: unknown): string => (typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v))

export function Chart({ type, columns, rows, x, y, label, value }: {
  type: 'bar' | 'line' | 'pie'
  columns: Pick<ResultColumn, 'name'>[]
  rows: unknown[][]
  x?: string
  y?: string[]
  label?: string // pie label column (defaults to x)
  value?: string // pie value column (defaults to y[0])
}): ReactNode {
  const t = useTokens()
  const cd = useMemo(() => chartData(columns, rows, x, y), [columns, rows, x, y])
  const slices = useMemo(() => (type === 'pie' ? pieData(columns, rows, label ?? x, value ?? y?.[0], SERIES.length) : []), [type, columns, rows, label, value, x, y])
  const color = (i: number): string => t[SERIES[i]]
  const series = cd.y.slice(0, SERIES.length) // never cycle colours; extra series are dropped with a note

  if (!rows.length) return <div className="empty">No rows to chart</div>
  if (type === 'pie' ? !slices.length : !series.length) return <div className="empty">Pick a numeric {type === 'pie' ? 'value' : 'y-axis'} column in the chart settings</div>

  const axis = { stroke: t['--border'], tick: { fill: t['--fg-muted'], fontSize: 11 }, tickLine: false }
  const tooltip = (
    <Tooltip
      formatter={(v) => fmt(v)}
      contentStyle={{ background: t['--bg-elev'], border: `1px solid ${t['--border']}`, borderRadius: 6, fontSize: 12, color: t['--fg'] }}
      labelStyle={{ color: t['--fg-muted'] }}
      itemStyle={{ color: t['--fg'] }}
      cursor={type === 'bar' ? { fill: t['--grid-line'] } : { stroke: t['--border'] }}
    />
  )
  const legend = (n: number): ReactNode => n > 1 && <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: t['--fg-muted'] }} />
  const margin = { top: 8, right: 16, bottom: 4, left: 4 }

  return (
    <div className="chart-box" role="img" aria-label={`${type} chart of ${type === 'pie' ? (value ?? y?.[0] ?? '') : series.join(', ')} by ${cd.x}`}>
      <ResponsiveContainer width="100%" height="100%">
        {type === 'pie' ? (
          <PieChart margin={margin}>
            <Pie
              data={slices.map((s, i) => ({ ...s, fill: s.other ? t['--fg-faint'] : color(i) }))}
              dataKey="value"
              nameKey="name"
              innerRadius="45%"
              outerRadius="80%"
              stroke={t['--bg-panel']}
              strokeWidth={2}
              isAnimationActive={false}
            />
            {tooltip}
            {legend(slices.length)}
          </PieChart>
        ) : type === 'bar' ? (
          <BarChart data={cd.data} margin={margin}>
            <CartesianGrid vertical={false} stroke={t['--grid-line']} />
            <XAxis dataKey={cd.x} {...axis} />
            <YAxis {...axis} axisLine={false} tickFormatter={fmt} width={48} />
            {tooltip}
            {legend(series.length)}
            {series.map((s, i) => <Bar key={s} dataKey={s} fill={color(i)} radius={[4, 4, 0, 0]} maxBarSize={48} isAnimationActive={false} />)}
          </BarChart>
        ) : (
          <LineChart data={cd.data} margin={margin}>
            <CartesianGrid vertical={false} stroke={t['--grid-line']} />
            <XAxis dataKey={cd.x} {...axis} />
            <YAxis {...axis} axisLine={false} tickFormatter={fmt} width={48} />
            {tooltip}
            {legend(series.length)}
            {series.map((s, i) => <Line key={s} dataKey={s} stroke={color(i)} strokeWidth={2} dot={cd.data.length <= 40 ? { r: 3 } : false} activeDot={{ r: 4 }} connectNulls isAnimationActive={false} />)}
          </LineChart>
        )}
      </ResponsiveContainer>
      {cd.y.length > series.length && type !== 'pie' && <div className="chart-note faint">{cd.y.length - series.length} more series not shown</div>}
    </div>
  )
}
