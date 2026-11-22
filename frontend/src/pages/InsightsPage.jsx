import { useMemo, useState } from 'react';
import ChartCard from '../components/charts/ChartCard.jsx';
import HBarChart from '../components/charts/HBarChart.jsx';
import LatencyStrip from '../components/LatencyStrip.jsx';
import TriageSplit from '../components/TriageSplit.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useTickets } from '../state/tickets.jsx';
import { LANGUAGES, PIPELINE_STAGES, REASONS } from '../lib/constants.js';
import { ms } from '../lib/format.js';
// Read-only: exported by the data analyst (analytics/ → features/insights/data).
import ops from '../features/insights/data/operations_insights.json';
import model from '../features/insights/data/model_insights.json';

const VIEWS = [
  { id: 'dataset', label: 'Dataset & model' },
  { id: 'session', label: 'This session' },
];

const fmt = (n) => n.toLocaleString('en-US');
const pct1 = (x) => `${(x * 100).toFixed(0)}%`;
const shortQueue = (q) => q.replace(' and Maintenance', '').replace(' and Payments', '').replace(' and Pre-Sales', '').replace(' and Exchanges', '');

export default function InsightsPage() {
  const [view, setView] = useState('dataset');
  return (
    <div className="px-4 py-5 sm:px-6 lg:px-8">
      <PageHeader title="Reports" description="Why the gate is safe to trust, from the training data and held-out evaluation, plus what happened in this session." />
      <div className="mt-4 flex flex-wrap items-center gap-1 border-b border-line" role="tablist" aria-label="Reports view">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            role="tab"
            aria-selected={view === v.id}
            onClick={() => setView(v.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-[14px] font-medium transition ${view === v.id ? 'border-brand-700 text-ink' : 'border-transparent text-ink-3 hover:text-ink'}`}
          >
            {v.label}
          </button>
        ))}
      </div>
      {view === 'dataset' ? <DatasetStory /> : <SessionReport />}
    </div>
  );
}

// ---------------------------------------------------------------- dataset & model

function DatasetStory() {
  const m = model.holdout_benchmark.metrics;
  const lat = model.holdout_benchmark.latency;
  const placeholder = model.metrics_source !== 'holdout_eval';
  const gate = model.safety_gate_policy;

  return (
    <div className="mt-5 space-y-5">
      {/* The one loud element: a plain-language summary on navy, numbers carried by weight */}
      <section className="relative overflow-hidden rounded-2xl bg-brand-950 px-6 py-7 text-slate-300 sm:px-9 sm:py-9">
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:radial-gradient(circle_at_1px_1px,white_1px,transparent_0)] [background-size:22px_22px]" />
        <p className="relative max-w-5xl text-[22px] leading-[1.45] font-medium sm:text-[28px]">
          Trained on <b className="tabular font-semibold text-white">{fmt(model.holdout_benchmark.kb_size ?? ops.total_volume)}</b> real support tickets in English and
          German. On <b className="tabular font-semibold text-white">{fmt(model.holdout_benchmark.eval_sample_size)}</b> tickets it never saw, the gate escalates{' '}
          <b className="tabular font-semibold text-teal-300">{Math.round(m.high_priority_incident_recall * 100)} of every 100</b> high-priority incidents
          {lat.total_e2e_latency_ms != null ? (
            <>
              , in <b className="tabular font-semibold text-white">{ms(lat.total_e2e_latency_ms)}</b>.
            </>
          ) : (
            '.'
          )}
        </p>
        {placeholder && (
          <p className="relative mt-4 inline-flex rounded-md bg-amber-300/15 px-2.5 py-1 text-[12.5px] text-amber-200">
            Model numbers are placeholders until the holdout evaluation is exported.
          </p>
        )}
      </section>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <RecallStory recall={m.high_priority_incident_recall} precision={m.high_priority_incident_precision} placeholder={placeholder} />
        <Composition />
      </div>

      <RiskByQueue />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <GateRuler gate={gate} />
        <ModelQuality m={m} lat={lat} placeholder={placeholder} />
      </div>

      <p className="text-[12px] text-ink-3">
        Source: {ops.dataset_name}. Exported {new Date(ops.generated_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}. Check with{' '}
        <code className="text-ink-2">{ops.verify_command}</code>.
      </p>
    </div>
  );
}

function Panel({ title, lede, tag, children, className = '' }) {
  return (
    <section className={`rounded-2xl border border-line bg-card px-5 py-5 sm:px-6 ${className}`}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">{title}</h2>
        {tag && <span className="mt-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-[11.5px] font-medium text-amber-900">{tag}</span>}
      </div>
      {lede && <p className="mt-1 max-w-[68ch] text-[13.5px] leading-relaxed text-ink-2">{lede}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

// 100 dots, one per real high-priority incident: filled = escalated, hollow = missed.
function RecallStory({ recall, precision, placeholder }) {
  const caught = Math.round(recall * 100);
  const falseAlarms = Math.round(caught * (1 / precision - 1));
  return (
    <Panel
      title="Missing an outage costs more than an extra check"
      lede={`The gate is tuned for recall. Of 100 real high-priority incidents, ${caught} page on-call. In exchange, about ${falseAlarms} more tickets get escalated that turn out not to be, which costs a person a quick look, not a missed outage.`}
      tag={placeholder ? 'Placeholder' : null}
    >
      <div className="flex flex-wrap items-center gap-6">
        <div className="grid grid-cols-10 gap-[5px]" role="img" aria-label={`${caught} of 100 high-priority incidents escalated`}>
          {Array.from({ length: 100 }, (_, i) => (
            <span key={i} className={`h-3.5 w-3.5 rounded-full ${i < caught ? 'bg-red-600' : 'border-2 border-red-300 bg-card'}`} />
          ))}
        </div>
        <dl className="space-y-3 text-[13px]">
          <div>
            <dt className="flex items-center gap-2 text-ink-2"><span className="h-3 w-3 rounded-full bg-red-600" /> Escalated to on-call</dt>
            <dd className="tabular text-[30px] leading-tight font-semibold text-ink">{caught}</dd>
          </div>
          <div>
            <dt className="flex items-center gap-2 text-ink-2"><span className="h-3 w-3 rounded-full border-2 border-red-300" /> Missed</dt>
            <dd className="tabular text-[30px] leading-tight font-semibold text-ink">{100 - caught}</dd>
          </div>
          <div className="text-ink-3">Precision {pct1(precision)}</div>
        </dl>
      </div>
    </Panel>
  );
}

const TYPE_COLORS = { Incident: 'bg-brand-800', Request: 'bg-teal-600', Problem: 'bg-sky-400', Change: 'bg-slate-300' };
const PRIORITY_COLORS = { high: 'bg-red-600', medium: 'bg-amber-400', low: 'bg-slate-300' };
const LANG_COLORS = { en: 'bg-teal-600', de: 'bg-brand-800' };

function Strip({ label, parts }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return (
    <div>
      <div className="mb-1.5 text-[13px] font-medium text-ink-2">{label}</div>
      <div className="flex h-9 gap-[3px] overflow-hidden rounded-lg">
        {parts.map((p) => {
          const share = p.value / total;
          return (
            <div key={p.label} title={`${p.label}: ${fmt(p.value)} (${Math.round(share * 100)}%)`} className={`${p.color} flex min-w-0 items-center px-2.5`} style={{ width: `${share * 100}%` }}>
              {share > 0.22 && (
                <span className={`truncate text-[12.5px] font-semibold ${p.dark ? 'text-ink' : 'text-white'}`}>
                  {p.label} <span className="tabular font-normal opacity-80">{Math.round(share * 100)}%</span>
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-3">
        {parts.filter((p) => p.value / total <= 0.22).map((p) => (
          <span key={p.label} className="flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-sm ${p.color}`} />{p.label} {Math.round((p.value / total) * 100)}%</span>
        ))}
      </div>
    </div>
  );
}

function Composition() {
  const types = Object.entries(ops.types).map(([k, v]) => ({ label: k, value: v, color: TYPE_COLORS[k], dark: k === 'Change' || k === 'Problem' }));
  const prio = ['high', 'medium', 'low'].map((k) => ({ label: k[0].toUpperCase() + k.slice(1), value: ops.priorities[k], color: PRIORITY_COLORS[k], dark: k !== 'high' }));
  const langs = Object.entries(ops.languages.counts).map(([k, v]) => ({ label: LANGUAGES[k] ?? k, value: v, color: LANG_COLORS[k] }));
  return (
    <Panel title="What comes in" lede={`${fmt(ops.total_volume)} tickets. Two in five are incidents, and high priority is as common as medium.`}>
      <div className="space-y-4">
        <Strip label="Type" parts={types} />
        <Strip label="Priority" parts={prio} />
        <Strip label="Language" parts={langs} />
      </div>
    </Panel>
  );
}

// Volume and risk side by side: the busiest queue is not the riskiest per ticket.
function RiskByQueue() {
  const rows = Object.entries(ops.queues)
    .map(([q, total]) => {
      const crit = ops.critical_outages.by_queue[q] ?? 0;
      return { q, total, crit, rate: crit / total };
    })
    .sort((a, b) => b.rate - a.rate);
  const maxTotal = Math.max(...rows.map((r) => r.total));
  const maxRate = Math.max(...rows.map((r) => r.rate));
  const riskiest = rows[0];
  const mostCrit = [...rows].sort((a, b) => b.crit - a.crit)[0];

  return (
    <Panel
      title="Where the risk is"
      lede={`${shortQueue(riskiest.q)} has the highest share of high-priority incidents: ${Math.round(riskiest.rate * 100)}% of its tickets. ${shortQueue(mostCrit.q)} has the most of them, ${fmt(mostCrit.crit)} in total.`}
    >
      <div className="thin-scroll overflow-x-auto">
        <table className="w-full min-w-[640px] text-[13.5px]">
          <thead>
            <tr className="text-left text-[12.5px] text-ink-3">
              <th className="pb-2 font-medium">Queue</th>
              <th className="pb-2 font-medium">Tickets</th>
              <th className="pb-2 font-medium">High-priority incidents</th>
              <th className="pb-2 text-right font-medium">Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.q} className="border-t border-line/70">
                <td className="py-2 pr-4 font-medium whitespace-nowrap text-ink">{shortQueue(r.q)}</td>
                <td className="w-[30%] py-2 pr-6">
                  <span className="flex items-center gap-2">
                    <span className="h-2.5 rounded-sm bg-slate-300" style={{ width: `${(r.total / maxTotal) * 100}%` }} />
                    <span className="tabular text-[12.5px] text-ink-3">{fmt(r.total)}</span>
                  </span>
                </td>
                <td className="w-[34%] py-2 pr-4">
                  <span className="flex items-center gap-2">
                    <span className="h-2.5 rounded-sm bg-red-600" style={{ width: `${(r.rate / maxRate) * 100}%`, opacity: 0.35 + 0.65 * (r.rate / maxRate) }} />
                    <span className="tabular text-[12.5px] text-ink-3">{fmt(r.crit)}</span>
                  </span>
                </td>
                <td className="tabular py-2 text-right font-semibold text-ink">{Math.round(r.rate * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// The three gate thresholds on one 0–1 scale, with what crossing each one does.
function GateRuler({ gate }) {
  const marks = [
    { v: gate.precedent_similarity_threshold, name: 'Similarity floor', what: 'Below it, no past ticket is close enough to quote. A person reviews.', color: 'bg-amber-500' },
    { v: gate.high_priority_threshold, name: 'High-priority line', what: 'An incident above it pages on-call before any reply is drafted.', color: 'bg-red-600' },
    { v: gate.confidence_floor, name: 'Confidence floor', what: 'Below it, the model is unsure of the triage. A person reviews.', color: 'bg-amber-500' },
  ];
  const p1 = gate.p1_codes.map((c) => REASONS[c]?.label ?? c);
  const p2 = gate.p2_codes.map((c) => REASONS[c]?.label ?? c);
  return (
    <Panel title="How the gate decides" lede="Three numbers and eleven rules. Any P1 rule pages on-call; any P2 rule holds the ticket for a person. Only tickets that pass everything get an automatic draft.">
      <div className="relative mt-2 mb-1 h-3 rounded-full bg-gradient-to-r from-slate-100 to-slate-200">
        {marks.map((mk) => (
          <span key={mk.name} className={`absolute top-1/2 h-6 w-[3px] -translate-y-1/2 rounded ${mk.color}`} style={{ left: `${mk.v * 100}%` }} />
        ))}
      </div>
      <div className="tabular flex justify-between text-[11.5px] text-ink-3"><span>0</span><span>0.5</span><span>1</span></div>
      <ol className="mt-3 space-y-2">
        {marks.map((mk) => (
          <li key={mk.name} className="flex gap-3 text-[13px]">
            <span className={`mt-1 h-3 w-[3px] shrink-0 rounded ${mk.color}`} />
            <span className="tabular w-10 shrink-0 font-semibold text-ink">{mk.v.toFixed(2)}</span>
            <span><b className="font-semibold text-ink">{mk.name}.</b> <span className="text-ink-2">{mk.what}</span></span>
          </li>
        ))}
      </ol>
      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <RuleList tone="red" title="Pages on-call (P1)" items={p1} />
        <RuleList tone="amber" title="Holds for a person (P2)" items={p2} />
      </div>
    </Panel>
  );
}

function RuleList({ tone, title, items }) {
  const cls = tone === 'red' ? 'border-red-200 bg-red-50/60 text-red-900' : 'border-amber-200 bg-amber-50/60 text-amber-900';
  return (
    <div className={`rounded-xl border px-4 py-3 ${cls}`}>
      <h3 className="text-[13px] font-semibold">{title}</h3>
      <ul className="mt-1.5 space-y-1 text-[13px] text-ink-2">
        {items.map((i) => <li key={i}>{i}</li>)}
      </ul>
    </div>
  );
}

function ModelQuality({ m, lat, placeholder }) {
  const heads = [
    { label: 'Type', v: m.type_macro_f1, note: '4 classes' },
    { label: 'Priority', v: m.priority_macro_f1, note: '3 classes' },
    { label: 'Queue', v: m.queue_macro_f1, note: '10 classes' },
  ];
  const stages = [
    { label: 'Classify', v: lat.triage_inference_per_ticket_ms, color: 'bg-brand-800' },
    { label: 'Retrieve', v: lat.precedent_retrieval_ms, color: 'bg-teal-600' },
    { label: 'Draft', v: lat.grounded_synthesis_ms, color: 'bg-sky-400' },
  ];
  const total = lat.total_e2e_latency_ms;
  // Retrieval and drafting need the live stack, so an offline export may only carry the classify time.
  const full = total != null && stages.every((s) => s.v != null);
  const top = full ? [...stages].sort((a, b) => b.v - a.v)[0] : null;
  const speed = full
    ? top.v / total >= 0.95
      ? `${top.label} is almost all of the ${ms(total)}; classifying takes ${ms(lat.triage_inference_per_ticket_ms)}.`
      : `${top.label} takes ${Math.round((top.v / total) * 100)}% of the ${ms(total)}.`
    : lat.triage_inference_per_ticket_ms != null
      ? `Classifying takes ${ms(lat.triage_inference_per_ticket_ms)} per ticket; the live time of every stage is shown on each triage and in the Session report.`
      : 'The live time of every stage is shown on each triage and in the Session report.';
  return (
    <Panel
      title="How well and how fast"
      lede={`Macro-F1 on held-out tickets for each classifier head. Queue is the hardest call, which is why low confidence hands the ticket to a person. ${speed}`}
      tag={placeholder ? 'Placeholder' : null}
    >
      <ul className="space-y-3">
        {heads.map((h) => (
          <li key={h.label} className="grid grid-cols-[72px_1fr_48px] items-center gap-3 text-[13px]">
            <span className="font-medium text-ink">{h.label}</span>
            <span className="relative h-3 rounded-full bg-sand-2">
              <span className="absolute inset-y-0 left-0 rounded-full bg-brand-700" style={{ width: `${h.v * 100}%` }} />
            </span>
            <span className="tabular text-right font-semibold text-ink">{pct1(h.v)}</span>
          </li>
        ))}
      </ul>
      {full && <div className="mt-6">
        <div className="mb-1.5 flex justify-between text-[13px]"><span className="font-medium text-ink-2">Time per ticket</span><span className="tabular font-semibold text-ink">{ms(total)}</span></div>
        <div className="flex h-3 gap-[2px] overflow-hidden rounded-full">
          {stages.map((s) => <span key={s.label} className={s.color} style={{ width: `${Math.max(1.5, (s.v / total) * 100)}%` }} title={`${s.label}: ${ms(s.v)}`} />)}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-ink-3">
          {stages.map((s) => <span key={s.label} className="flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-sm ${s.color}`} />{s.label} <span className="tabular text-ink-2">{ms(s.v)}</span></span>)}
        </div>
      </div>}
    </Panel>
  );
}

// ---------------------------------------------------------------- this session

const countBy = (xs, key) => {
  const m = new Map();
  xs.forEach((x) => {
    const k = key(x);
    (Array.isArray(k) ? k : [k]).forEach((kk) => m.set(kk, (m.get(kk) || 0) + 1));
  });
  return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
};

function SessionReport() {
  const { tickets } = useTickets();
  const d = useMemo(() => {
    const n = tickets.length;
    const avg = Object.fromEntries(PIPELINE_STAGES.map((s) => [s.id, n ? tickets.reduce((a, t) => a + (t.latency_ms?.[s.id] ?? 0), 0) / n : 0]));
    avg.total = n ? tickets.reduce((a, t) => a + (t.latency_ms?.total ?? 0), 0) / n : 0;
    const reasons = {};
    tickets.forEach((t) => t.gate.reasons.forEach((r) => { reasons[r.code] = (reasons[r.code] || 0) + 1; }));
    const slowest = n ? [...PIPELINE_STAGES].sort((a, b) => avg[b.id] - avg[a.id])[0] : null;
    return {
      n,
      avg,
      slowest,
      reasons: Object.entries(reasons).map(([code, value]) => ({ code, value })).sort((a, b) => b.value - a.value),
      queues: countBy(tickets, (t) => t.classification.queue.label),
      langs: countBy(tickets, (t) => LANGUAGES[t.language.code] ?? t.language.code),
    };
  }, [tickets]);
  const maxReason = Math.max(1, ...d.reasons.map((r) => r.value));

  return (
    <div className="mt-5 space-y-5">
      <TriageSplit tickets={tickets} />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Panel title="Why tickets were held" lede="How often each gate rule fired. One ticket can fire more than one.">
          {d.reasons.length === 0 ? (
            <p className="text-[13px] text-ink-3">No rule has fired yet.</p>
          ) : (
            <ul className="space-y-2.5">
              {d.reasons.map((r) => {
                const p1 = REASONS[r.code]?.severity === 'P1';
                return (
                  <li key={r.code} className="grid grid-cols-[minmax(0,180px)_1fr_28px] items-center gap-3 text-[13px]">
                    <span className="truncate text-ink" title={REASONS[r.code]?.hint}>
                      <b className={`mr-1.5 font-semibold ${p1 ? 'text-red-700' : 'text-amber-700'}`}>{REASONS[r.code]?.severity}</b>
                      {REASONS[r.code]?.label ?? r.code}
                    </span>
                    <span className="h-2.5 rounded-full bg-sand-2">
                      <span className={`block h-full rounded-full ${p1 ? 'bg-red-600' : 'bg-amber-400'}`} style={{ width: `${(r.value / maxReason) * 100}%` }} />
                    </span>
                    <span className="tabular text-right font-semibold">{r.value}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
        <Panel title="Where the time goes" lede={`Average per ticket across ${d.n} tickets. ${d.slowest ? `${d.slowest.label} is the slowest step at ${ms(d.avg[d.slowest.id])}.` : ''}`}>
          <LatencyStrip latency={d.avg} />
        </Panel>
        <ChartCard title="Tickets by suggested queue" subtitle="This session" table={d.queues}>
          <HBarChart data={d.queues} labelWidth={190} />
        </ChartCard>
        <ChartCard title="Tickets by language" subtitle="English and German are supported; others go to a person" table={d.langs}>
          <HBarChart data={d.langs} labelWidth={90} />
        </ChartCard>
      </div>
    </div>
  );
}
