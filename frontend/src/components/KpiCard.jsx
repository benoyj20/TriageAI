import { Info } from 'lucide-react';

// Stat tile: proportional figures for the value (no tabular-nums on a standalone number).
export default function KpiCard({ icon: Icon, iconClass = 'text-brand-600 bg-brand-100', label, value, unit, hint }) {
  return (
    <div className="min-w-[200px] flex-1 rounded border border-line bg-card px-4 py-3">
      <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
        <span className={`grid h-6 w-6 place-items-center rounded ${iconClass}`}>
          <Icon size={14} aria-hidden />
        </span>
        {label}
        {hint && (
          <span title={hint} className="text-ink-3">
            <Info size={13} aria-label={hint} />
          </span>
        )}
      </div>
      <div className="mt-1.5 pl-8">
        <span className="text-[22px] font-semibold text-ink">{value}</span>
        {unit && <span className="ml-1 text-[13px] text-ink-2">{unit}</span>}
      </div>
    </div>
  );
}
