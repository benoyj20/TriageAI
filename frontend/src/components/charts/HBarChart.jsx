import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

// FS-18 — single-series ranked horizontal bars. One series, so one color (series slot 1),
// thin bars with 4px rounded data ends, hairline grid, per-bar hover tooltip.
const C = {
  series: 'var(--color-series-1)',
  grid: 'var(--color-chart-grid)',
  axis: 'var(--color-chart-axis)',
  muted: 'var(--color-chart-muted)',
  label: 'var(--color-ink-2)',
};

function Tip({ active, payload, format }) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="rounded border border-line bg-card px-2.5 py-1.5 text-[12px] shadow-md">
      <div className="text-ink-2">{p.payload.label}</div>
      <div className="tabular font-semibold">{format(p.value)}</div>
    </div>
  );
}

export default function HBarChart({ data, format = (v) => v, labelWidth = 150 }) {
  const height = data.length * 28 + 32; // plot rows + x-axis band, so ticks never clip
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }} barCategoryGap={8}>
          <CartesianGrid horizontal={false} stroke={C.grid} />
          <XAxis type="number" tickFormatter={format} tick={{ fontSize: 11, fill: C.muted }} axisLine={{ stroke: C.axis }} tickLine={false} allowDecimals={false} />
          <YAxis type="category" dataKey="label" width={labelWidth} tick={{ fontSize: 11.5, fill: C.label }} axisLine={{ stroke: C.axis }} tickLine={false} />
          <Tooltip cursor={{ fill: 'rgba(42,120,214,0.06)' }} content={<Tip format={format} />} />
          <Bar dataKey="value" fill={C.series} radius={[0, 4, 4, 0]} maxBarSize={14} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
