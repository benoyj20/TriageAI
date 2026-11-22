import { useState } from 'react';
import { BarChart3, Table2 } from 'lucide-react';

// FS-18 — shared chart frame. Every chart gets a table-view twin (values are never tooltip-only).
// `table` is [{label, value}] plus a formatter, so feature code only passes data.
export default function ChartCard({ title, subtitle, table, format = (v) => v, children, className = '' }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className={`rounded border border-line bg-card px-4 py-3 ${className}`}>
      <header className="mb-2 flex items-start gap-2">
        <div className="min-w-0">
          <h3 className="text-[13.5px] font-semibold">{title}</h3>
          {subtitle && <p className="text-[11.5px] text-ink-3">{subtitle}</p>}
        </div>
        {table && (
          <button
            onClick={() => setAsTable((v) => !v)}
            className="ml-auto flex items-center gap-1 rounded border border-line px-2 py-0.5 text-[11.5px] text-ink-2 hover:bg-sand"
            aria-pressed={asTable}
          >
            {asTable ? <BarChart3 size={12} /> : <Table2 size={12} />} {asTable ? 'Chart' : 'Table'}
          </button>
        )}
      </header>
      {asTable && table ? (
        <table className="w-full text-[12px]">
          <tbody>
            {table.map((r) => (
              <tr key={r.label} className="border-b border-line/70 last:border-0">
                <td className="py-1 pr-3 text-ink-2">{r.label}</td>
                <td className="tabular py-1 text-right">{format(r.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        children
      )}
    </section>
  );
}
