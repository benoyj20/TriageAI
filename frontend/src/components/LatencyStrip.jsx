import { Timer } from 'lucide-react';
import { PIPELINE_STAGES } from '../lib/constants.js';
import { ms } from '../lib/format.js';

// FS-11 — per-stage pipeline timing. Stages are an ordered sequence, so they share one hue
// stepped light→dark; the label row underneath carries identity (never color alone).
const STEPS = ['#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#1c5cab'];

export default function LatencyStrip({ latency }) {
  if (!latency) return null;
  const stages = PIPELINE_STAGES.map((s, i) => ({ ...s, value: latency[s.id] ?? 0, color: STEPS[i] }));
  const total = latency.total ?? stages.reduce((a, s) => a + s.value, 0);
  // Give tiny stages a visible sliver; the label row still shows the true numbers.
  const minShare = 0.035;
  const shares = stages.map((s) => Math.max(minShare, total > 0 ? s.value / total : 0));
  const norm = shares.reduce((a, b) => a + b, 0);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-[12px]">
        <span className="flex items-center gap-1.5 font-medium text-ink">
          <Timer size={13} aria-hidden /> Pipeline latency
        </span>
        <span className="tabular font-semibold">{ms(total)}</span>
      </div>
      <div className="flex h-2.5 gap-[2px]" role="img" aria-label={`Total ${ms(total)}`}>
        {stages.map((s, i) => (
          <div
            key={s.id}
            title={`${s.label}: ${ms(s.value)}`}
            className="h-full first:rounded-l last:rounded-r"
            style={{ width: `${(shares[i] / norm) * 100}%`, background: s.color }}
          />
        ))}
      </div>
      <dl className="mt-2 grid grid-cols-4 gap-x-3 gap-y-1 text-[11px] sm:grid-cols-7">
        {stages.map((s) => (
          <div key={s.id} className="flex flex-col">
            <dt className="flex items-center gap-1 text-ink-3">
              <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
              {s.label}
            </dt>
            <dd className={`tabular text-ink ${s.value >= 5000 ? 'font-semibold text-red-700' : ''}`}>{ms(s.value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
