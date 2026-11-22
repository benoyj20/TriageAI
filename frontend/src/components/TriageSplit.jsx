import { ms } from '../lib/format.js';
import { VIEW_BY_ID, viewHref } from '../lib/views.js';

// The three gate outcomes, in the order a ticket is checked. Colors match the side-rail queue dots.
export const OUTCOMES = [
  { id: 'escalated', bar: 'bg-red-600', text: 'text-red-700', what: 'On-call paged, draft held' },
  { id: 'review', bar: 'bg-amber-400', text: 'text-amber-700', what: 'A safety check fired' },
  { id: 'auto', bar: 'bg-teal-500', text: 'text-teal-700', what: 'Grounded draft ready to send' },
];

export const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// One bar, three segments: how the escalation gate split every ticket in this session.
// Each segment and its legend link to the matching Overview view.
export default function TriageSplit({ tickets, active }) {
  const n = tickets.length;
  const masked = tickets.filter((t) => t.pii?.masked?.length).length;
  const p50 = median(tickets.map((t) => t.latency_ms?.total).filter((x) => x != null));
  const parts = OUTCOMES.map((o) => {
    const v = VIEW_BY_ID[o.id];
    return { ...o, label: v.label, count: tickets.filter((t) => t.gate.decision === v.decision).length };
  });

  return (
    <section className="rounded-xl border border-line bg-card px-4 py-4 sm:px-5" aria-label="How the gate split this session's tickets">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 className="text-[15px] font-semibold text-ink">
          The gate sorted <span className="tabular">{n}</span> ticket{n === 1 ? '' : 's'}
        </h2>
        <p className="text-[13px] text-ink-3">
          PII masked in {masked} before the model saw them{p50 != null && <>. Median triage {ms(p50)}</>}.
        </p>
      </div>

      <div className="mt-3 flex h-3 gap-0.5 overflow-hidden rounded-full bg-sand-2">
        {n > 0 && parts.map((p) => p.count > 0 && (
          <a key={p.id} href={viewHref(p.id)} title={`${p.count} ${p.label.toLowerCase()}`} className={`${p.bar} transition-opacity hover:opacity-80`} style={{ width: `${(p.count / n) * 100}%` }} />
        ))}
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {parts.map((p) => {
          const on = active === p.id;
          return (
            <a
              key={p.id}
              href={viewHref(p.id)}
              aria-current={on ? 'page' : undefined}
              className={`flex items-baseline gap-3 rounded-lg border px-3 py-2 transition ${on ? 'border-brand-600 bg-brand-50' : 'border-transparent hover:border-line hover:bg-sand'}`}
            >
              <span className={`tabular text-[28px] leading-none font-semibold ${p.text}`}>{p.count}</span>
              <span className="min-w-0">
                <span className="block text-[14px] font-semibold text-ink">{p.label}</span>
                <span className="block text-[12.5px] text-ink-3">{p.what}</span>
              </span>
              <span className="tabular ml-auto text-[13px] text-ink-3">{n ? Math.round((p.count / n) * 100) : 0}%</span>
            </a>
          );
        })}
      </div>
    </section>
  );
}
