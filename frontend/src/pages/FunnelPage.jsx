import { useMemo, useState } from 'react';
import { useTickets } from '../state/tickets.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { LANGUAGES, PRIORITIES, REASONS } from '../lib/constants.js';

// Incident manager: how live tickets flow through triage, with simple pivots.
// Funnel stages are ordinal (one navy ramp, validated); gate outcomes keep the app's status colours, always labelled.

const RAMP = ['#0f273e', '#1a446c', '#255d91', '#5b8fc7']; // brand-900 → lighter; validate_palette --ordinal: all pass
const BAR_HUE = '#255d91'; // one hue for the reason list
const DECISION_STYLE = {
  ESCALATE_ONCALL: { bar: 'bg-red-500', label: 'Escalated to on-call', href: '#/view/escalated' },
  HUMAN_REVIEW: { bar: 'bg-amber-400', label: 'Human review', href: '#/view/review' },
  AUTO_DRAFT: { bar: 'bg-teal-400', label: 'Auto-drafted', href: '#/view/auto' },
};
const ORDER = ['ESCALATE_ONCALL', 'HUMAN_REVIEW', 'AUTO_DRAFT'];

const sourceOf = (t) => (/^SIM-/i.test(t.ticket_id) ? 'Outage drill' : /^TEST-/i.test(t.ticket_id) ? 'Live triage test' : 'Customer');
const SOURCES = [
  { id: 'all', label: 'All tickets', test: () => true },
  { id: 'customer', label: 'Customer tickets', test: (t) => sourceOf(t) === 'Customer' },
  { id: 'test', label: 'Tests & drills', test: (t) => sourceOf(t) !== 'Customer' },
];
const PIVOTS = [
  { id: 'language', label: 'Language', get: (t) => LANGUAGES[t.language.code] ?? 'Other' }, // too short or not EN/DE
  { id: 'queue', label: 'Queue', get: (t) => t.classification.queue.label },
  { id: 'priority', label: 'Priority', get: (t) => PRIORITIES[t.classification.priority.label]?.label ?? t.classification.priority.label },
  { id: 'type', label: 'Type', get: (t) => t.classification.type.label },
  { id: 'decision', label: 'Gate decision', get: (t) => DECISION_STYLE[t.gate.decision].label },
  { id: 'source', label: 'Source', get: sourceOf },
];

const has = (t, code) => t.gate.reasons.some((r) => r.code === code);
const STAGES = [
  { label: 'Received', tip: 'Every ticket in scope.', test: () => true },
  {
    label: 'Understood',
    tip: 'English or German, and the engine ran without falling back.',
    test: (t) => ['en', 'de'].includes(t.language.code) && !has(t, 'ENGINE_DEGRADED') && !has(t, 'UNSUPPORTED_LANGUAGE'),
  },
  { label: 'Matched a past case', tip: 'A past ticket was similar enough to ground a reply.', test: (t) => !has(t, 'NO_PRECEDENT') },
  {
    label: 'Cleared for auto-draft',
    tip: 'No safety check fired: a grounded reply is ready to send.',
    test: (t) => t.gate.decision === 'AUTO_DRAFT',
  },
];

const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const countBy = (items, key) => items.reduce((m, t) => m.set(key(t), (m.get(key(t)) ?? 0) + 1), new Map());

// Small styled tooltip; every value it shows is also printed on the page.
function Tip({ text, children, className = '', end = false }) {
  return (
    <span className={`group/tip relative ${className}`}>
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute bottom-full z-20 mb-1.5 w-max max-w-[240px] ${end ? 'right-0' : 'left-1/2 -translate-x-1/2'} rounded-md bg-brand-950 px-2 py-1 text-[11.5px] leading-snug font-normal text-white opacity-0 shadow-sentinel-md transition group-hover/tip:opacity-100 group-focus-within/tip:opacity-100`}
      >
        {text}
      </span>
    </span>
  );
}

function Card({ title, sub, children, className = '' }) {
  return (
    <section className={`min-w-0 rounded-2xl border border-line bg-card px-5 py-5 sm:px-6 ${className}`}>
      <h2 className="text-[16px] font-semibold tracking-tight text-ink">{title}</h2>
      {sub && <p className="mt-0.5 text-[12.5px] text-ink-3">{sub}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Funnel({ tickets }) {
  const rows = [];
  let pool = tickets;
  STAGES.forEach((s, i) => {
    pool = pool.filter(s.test);
    rows.push({ ...s, n: pool.length, drop: i ? rows[i - 1].n - pool.length : 0 });
  });
  const total = tickets.length;
  const worst = rows.slice(1).reduce((a, r) => (r.drop > (a?.drop ?? 0) ? r : a), null);
  return (
    <>
      <ol className="space-y-3.5">
        {rows.map((r, i) => (
          <li key={r.label} className="group/tip relative">
            <div className="flex items-baseline gap-2 text-[13px]">
              <Tip text={i && r.drop ? `${r.tip} ${r.drop} ticket${r.drop > 1 ? 's' : ''} stopped at this step.` : r.tip}>
                <span tabIndex={0} className="cursor-help font-medium text-ink outline-none focus-visible:underline">
                  {r.label}
                </span>
              </Tip>
              <span className="ml-auto tabular font-semibold text-ink">{r.n}</span>
              <span className="tabular w-10 text-right text-ink-3">{pct(r.n, total)}%</span>
            </div>
            <div className="mt-1.5 h-3.5">
              <div
                className="h-full rounded-[4px] transition-[width] duration-500"
                style={{ width: r.n ? `max(4px, ${(r.n / total) * 100}%)` : 0, background: RAMP[i] }}
                aria-hidden
              />
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-6 border-t border-line pt-4 text-[13px] leading-relaxed text-ink-2">
        <span className="font-semibold text-ink">{pct(rows[3].n, total)}%</span> of these tickets got a reply ready without a person.
        {worst && (
          <>
            {' '}
            The biggest drop is at <span className="font-medium text-ink">{worst.label.toLowerCase()}</span> ({worst.drop} ticket
            {worst.drop > 1 ? 's' : ''}).
          </>
        )}
      </p>
    </>
  );
}

function Waterfall({ tickets }) {
  const N = tickets.length;
  const c = countBy(tickets, (t) => t.gate.decision);
  const esc = c.get('ESCALATE_ONCALL') ?? 0;
  const rev = c.get('HUMAN_REVIEW') ?? 0;
  const auto = c.get('AUTO_DRAFT') ?? 0;
  const cols = [
    { label: 'Received', value: N, lo: 0, hi: N, bar: 'bg-brand-700' },
    { ...DECISION_STYLE.ESCALATE_ONCALL, value: esc, lo: N - esc, hi: N },
    { ...DECISION_STYLE.HUMAN_REVIEW, value: rev, lo: auto, hi: auto + rev },
    { ...DECISION_STYLE.AUTO_DRAFT, value: auto, lo: 0, hi: auto },
  ];
  const H = 168;
  const left = tickets.filter((t) => t.gate.decision !== 'AUTO_DRAFT');
  const reasons = [
    ...countBy(
      left.flatMap((t) => [...new Set(t.gate.reasons.map((r) => r.code))]),
      (x) => x,
    ),
  ]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const maxR = reasons[0]?.[1] ?? 1;

  return (
    <>
      <div className="flex items-end gap-2 border-b border-line-dark sm:gap-4" style={{ height: H + 24 }}>
        {cols.map((col) => {
          const body = (
            <>
              <div className="relative w-full" style={{ height: H }}>
                <span
                  className="tabular absolute inset-x-0 text-center text-[13px] font-semibold text-ink"
                  style={{ bottom: (N ? col.hi / N : 0) * H + 4 }}
                >
                  {col.value}
                </span>
                <div
                  className={`absolute inset-x-[18%] rounded-[4px] ${col.bar}`}
                  style={{ bottom: (N ? col.lo / N : 0) * H, height: col.value ? `max(3px, ${(col.value / (N || 1)) * H}px)` : 0 }}
                  aria-hidden
                />
              </div>
            </>
          );
          const tip = `${col.label}: ${col.value} of ${N} (${pct(col.value, N)}%)`;
          return (
            <Tip key={col.label} text={tip} className="flex h-full flex-1 items-end">
              {col.href ? (
                <a
                  href={col.href}
                  aria-label={`${tip}. Open the list`}
                  className="block w-full rounded-md outline-none hover:bg-page focus-visible:ring-2 focus-visible:ring-teal-400"
                >
                  {body}
                </a>
              ) : (
                <div className="w-full">{body}</div>
              )}
            </Tip>
          );
        })}
      </div>
      <div className="mt-2 flex gap-2 sm:gap-4">
        {cols.map((col) => (
          <div key={col.label} className="flex flex-1 items-start justify-center gap-1.5 text-center text-[12px] leading-tight text-ink-2">
            <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${col.bar}`} aria-hidden />
            {col.label}
          </div>
        ))}
      </div>

      <h3 className="mt-6 text-[13px] font-semibold text-ink">Why tickets left the automatic path</h3>
      {reasons.length === 0 ? (
        <p className="mt-2 text-[12.5px] text-ink-3">Every ticket here was auto-drafted.</p>
      ) : (
        <ul className="mt-2.5 space-y-2">
          {reasons.map(([code, n]) => (
            <li key={code} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-[12.5px]">
              <Tip text={REASONS[code]?.hint ?? code}>
                <span tabIndex={0} className="block cursor-help truncate text-ink-2 outline-none">
                  {REASONS[code]?.label ?? code}
                </span>
              </Tip>
              <span className="h-2.5">
                <span className="block h-full rounded-[4px]" style={{ width: `${(n / maxR) * 100}%`, background: BAR_HUE }} aria-hidden />
              </span>
              <span className="tabular text-right font-medium text-ink">{n}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Mix({ c, total }) {
  return (
    <div className="flex h-2.5 w-[120px] gap-[2px]" aria-hidden>
      {ORDER.map((d) =>
        c[d] ? (
          <span key={d} className={`h-full rounded-[3px] ${DECISION_STYLE[d].bar}`} style={{ width: `${(c[d] / total) * 100}%` }} />
        ) : null,
      )}
    </div>
  );
}

function PivotTable({ tickets, pivot, chip, onChip }) {
  const rows = useMemo(() => {
    const groups = new Map();
    tickets.forEach((t) => {
      const k = pivot.get(t);
      const g = groups.get(k) ?? { key: k, n: 0, ESCALATE_ONCALL: 0, HUMAN_REVIEW: 0, AUTO_DRAFT: 0, resolved: 0 };
      g.n += 1;
      g[t.gate.decision] += 1;
      if (t.status === 'resolved') g.resolved += 1;
      groups.set(k, g);
    });
    return [...groups.values()].sort((a, b) => b.n - a.n || String(a.key).localeCompare(String(b.key)));
  }, [tickets, pivot]);
  const total = rows.reduce(
    (s, r) => ({
      ...s,
      n: s.n + r.n,
      ESCALATE_ONCALL: s.ESCALATE_ONCALL + r.ESCALATE_ONCALL,
      HUMAN_REVIEW: s.HUMAN_REVIEW + r.HUMAN_REVIEW,
      AUTO_DRAFT: s.AUTO_DRAFT + r.AUTO_DRAFT,
      resolved: s.resolved + r.resolved,
    }),
    { key: 'Total', n: 0, ESCALATE_ONCALL: 0, HUMAN_REVIEW: 0, AUTO_DRAFT: 0, resolved: 0 },
  );
  const cells = (r) => [r.n, r.ESCALATE_ONCALL, r.HUMAN_REVIEW, r.AUTO_DRAFT, `${pct(r.AUTO_DRAFT, r.n)}%`, r.resolved];
  const th = 'px-3 py-2 text-right font-medium whitespace-nowrap';
  return (
    <div className="thin-scroll -mx-5 overflow-x-auto px-5 sm:-mx-6 sm:px-6">
      <table className="w-full min-w-[640px] text-[13px]">
        <thead>
          <tr className="border-b border-line text-[12px] text-ink-3">
            <th className="py-2 pr-3 text-left font-medium">{pivot.label}</th>
            {['Tickets', 'Escalated', 'Human review', 'Auto-drafted', 'Auto-draft rate', 'Resolved'].map((h) => (
              <th key={h} className={th}>
                {h}
              </th>
            ))}
            <th className="py-2 pl-3 text-left font-medium">Decision mix</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const on = chip === r.key;
            return (
              <tr
                key={r.key}
                onClick={() => onChip(on ? 'all' : r.key)}
                className={`cursor-pointer border-b border-line transition ${on ? 'bg-brand-50' : 'hover:bg-page'}`}
              >
                <td className="py-2 pr-3">
                  <button type="button" aria-pressed={on} className="text-left font-medium text-ink outline-none focus-visible:underline">
                    {r.key}
                  </button>
                </td>
                {cells(r).map((v, i) => (
                  <td key={i} className="tabular px-3 py-2 text-right text-ink-2">
                    {v}
                  </td>
                ))}
                <td className="py-2 pl-3">
                  <Tip end text={ORDER.map((d) => `${DECISION_STYLE[d].label} ${r[d]}`).join(' · ')}>
                    <Mix c={r} total={r.n} />
                  </Tip>
                </td>
              </tr>
            );
          })}
          <tr className="font-semibold text-ink">
            <td className="py-2 pr-3">Total</td>
            {cells(total).map((v, i) => (
              <td key={i} className="tabular px-3 py-2 text-right">
                {v}
              </td>
            ))}
            <td className="py-2 pl-3">
              <Mix c={total} total={total.n || 1} />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const selectCls =
  'h-8 rounded-md border border-line-dark bg-card px-2 text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-teal-400';

export default function FunnelPage() {
  const { tickets } = useTickets();
  const [sourceId, setSourceId] = useState('all');
  const [pivotId, setPivotId] = useState('language');
  const [chip, setChip] = useState('all');
  const source = SOURCES.find((s) => s.id === sourceId);
  const pivot = PIVOTS.find((p) => p.id === pivotId);

  const scoped = useMemo(() => tickets.filter(source.test), [tickets, source]);
  const values = useMemo(() => [...countBy(scoped, pivot.get)].sort((a, b) => b[1] - a[1]), [scoped, pivot]);
  const active = values.some(([k]) => k === chip) ? chip : 'all';
  const focus = active === 'all' ? scoped : scoped.filter((t) => pivot.get(t) === active);
  const scopeNote = active === 'all' ? `${focus.length} tickets` : `${focus.length} tickets · ${pivot.label}: ${active}`;

  const chipCls = (on) =>
    `rounded-full border px-2.5 py-1 text-[12.5px] transition outline-none focus-visible:ring-2 focus-visible:ring-teal-400 ${on ? 'border-brand-700 bg-brand-700 text-white' : 'border-line-dark bg-card text-ink-2 hover:border-brand-600'}`;

  return (
    <div className="px-4 py-5 sm:px-6 lg:px-8">
      <PageHeader title="Funnel" description="How live tickets move through triage, and where they leave the automatic path." />

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2" role="group" aria-label="Filters">
        <label className="flex items-center gap-2 text-[12.5px] text-ink-3">
          Source
          <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} className={selectCls}>
            {SOURCES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[12.5px] text-ink-3">
          Pivot by
          <select
            value={pivotId}
            onChange={(e) => {
              setPivotId(e.target.value);
              setChip('all');
            }}
            className={selectCls}
          >
            {PIVOTS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-1.5" aria-label={`Filter by ${pivot.label}`}>
          <button type="button" aria-pressed={active === 'all'} onClick={() => setChip('all')} className={chipCls(active === 'all')}>
            All <span className="tabular opacity-70">{scoped.length}</span>
          </button>
          {values.map(([k, n]) => (
            <button key={k} type="button" aria-pressed={active === k} onClick={() => setChip(k)} className={chipCls(active === k)}>
              {k} <span className="tabular opacity-70">{n}</span>
            </button>
          ))}
        </div>
      </div>

      {scoped.length === 0 ? (
        <div className="mt-5 rounded-2xl border border-dashed border-line-dark bg-card/70 px-6 py-10 text-center text-[13.5px] text-ink-3">
          No tickets here yet. Paste one in{' '}
          <a href="#/lab" className="font-medium text-brand-600 hover:underline">
            Live triage
          </a>{' '}
          to watch it flow through.
        </div>
      ) : (
        <div className="mt-5 space-y-5">
          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Triage funnel" sub={`Each stage keeps only the tickets that passed the one before. ${scopeNote}.`}>
              <Funnel tickets={focus} />
            </Card>
            <Card
              title="Decision waterfall"
              sub={`How the received tickets split across the gate's three outcomes. Click a bar to open that list. ${scopeNote}.`}
            >
              <Waterfall tickets={focus} />
            </Card>
          </div>
          <Card title="Pivot" sub={`By ${pivot.label.toLowerCase()}. Click a row to focus the charts above.`}>
            <PivotTable tickets={scoped} pivot={pivot} chip={active} onChip={setChip} />
          </Card>
        </div>
      )}
    </div>
  );
}
