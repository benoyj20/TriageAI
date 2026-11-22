import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronLeft, ChevronRight, Loader2, Sparkles, X, Zap } from 'lucide-react';
import DetailsModal from '../components/DetailsModal.jsx';
import { ConfidenceBar, DecisionBadge, LangBadge, PriorityBadge, ReasonChip } from '../components/Badges.jsx';
import { useTickets } from '../state/tickets.jsx';
import { PRIORITIES } from '../lib/constants.js';
import { overallConfidence, ticketTitle, timeAgo } from '../lib/format.js';
import TriageSplit from '../components/TriageSplit.jsx';
import { ticketHref } from '../lib/useHashRoute.js';
import { VIEWS, VIEW_BY_ID, countView, viewHref } from '../lib/views.js';

const DECISION_RANK = { ESCALATE_ONCALL: 3, HUMAN_REVIEW: 2, AUTO_DRAFT: 1 };
const COLUMNS = [
  { key: 'created', label: 'Ticket', get: (t) => t.created_at },
  { key: 'subject', label: 'Subject', get: (t) => ticketTitle(t).toLowerCase() },
  { key: 'type', label: 'Type', get: (t) => t.classification.type.label, wide: true },
  { key: 'priority', label: 'Priority', get: (t) => PRIORITIES[t.classification.priority.label]?.rank ?? 0 },
  { key: 'decision', label: 'Gate decision', get: (t) => DECISION_RANK[t.gate.decision] },
  { key: 'queue', label: 'Suggested queue', get: (t) => t.classification.queue.label },
  { key: 'conf', label: 'Confidence', get: (t) => overallConfidence(t) },
];

export default function TriageDashboard({ view: viewId = 'needs', query, setQuery }) {
  const { tickets, review, toast, simulateOutage, busy } = useTickets();
  const view = VIEW_BY_ID[viewId] ?? VIEW_BY_ID.needs;
  const [sort, setSort] = useState({ key: 'created', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selected, setSelected] = useState(() => new Set());
  const [details, setDetails] = useState(null);

  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [view.id, query]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const col = COLUMNS.find((c) => c.key === sort.key);
    return tickets
      .filter(view.test)
      .filter((t) => !q || [t.ticket_id, t.subject, t.body, t.classification.queue.label, t.classification.type.label].some((f) => f?.toLowerCase().includes(q)))
      .sort((a, b) => {
        const x = col.get(a);
        const y = col.get(b);
        const cmp = x < y ? -1 : x > y ? 1 : 0;
        return sort.dir === 'asc' ? cmp : -cmp;
      });
  }, [tickets, view, query, sort]);

  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const cur = Math.min(page, pages);
  const visible = rows.slice((cur - 1) * pageSize, cur * pageSize);
  const allChecked = visible.length > 0 && visible.every((t) => selected.has(t.ticket_id));
  const picked = visible.filter((t) => selected.has(t.ticket_id));
  const needs = countView(tickets, 'needs');

  const toggleSort = (key) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }));
  const toggle = (id) => setSelected((s) => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });
  const toggleAll = () => setSelected((s) => {
    const n = new Set(s);
    visible.forEach((t) => (allChecked ? n.delete(t.ticket_id) : n.add(t.ticket_id)));
    return n;
  });
  const bulk = (verdict) => {
    picked.forEach((t) => review(t.ticket_id, verdict, verdict === 'accepted' ? ['queue'] : undefined));
    toast(`${verdict === 'accepted' ? 'Accepted' : 'Rejected'} suggestions on ${picked.length} ticket${picked.length > 1 ? 's' : ''}`, verdict === 'accepted' ? 'good' : 'info');
    setSelected(new Set());
  };

  return (
    <div className="space-y-4 px-4 py-5 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-[24px] font-semibold tracking-tight text-ink">Overview</h1>
          <p className="mt-0.5 text-[14px] text-ink-2">
            {needs === 0
              ? 'Nothing is waiting for you. New tickets are triaged as they arrive.'
              : `${needs} ticket${needs > 1 ? 's' : ''} need${needs > 1 ? '' : 's'} a person. Everything else was triaged automatically.`}
          </p>
        </div>
        <button
          onClick={simulateOutage}
          disabled={busy.outage}
          title="Demo: sends 4 drill tickets (tagged SIM) to show major-incident detection. Real tickets are never affected."
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-line-dark bg-card px-3 py-1.5 text-[12.5px] font-medium text-ink-2 transition hover:border-red-300 hover:text-red-700 disabled:opacity-60"
        >
          {busy.outage ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
          Outage drill
        </button>
      </header>

      <TriageSplit tickets={tickets} active={view.id} />

      <section className="rounded-xl border border-line bg-card">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2.5 sm:px-4">
          <nav className="flex flex-wrap gap-1" aria-label="Ticket views">
            {VIEWS.map((v) => {
              const on = v.id === view.id;
              return (
                <a
                  key={v.id}
                  href={viewHref(v.id)}
                  aria-current={on ? 'page' : undefined}
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13.5px] font-medium transition ${
                    on ? 'bg-brand-800 text-white' : 'text-ink-2 hover:bg-sand-2'
                  }`}
                >
                  {v.label}
                  <span className={`tabular text-[12.5px] ${on ? 'text-white/75' : 'text-ink-3'}`}>{countView(tickets, v.id)}</span>
                </a>
              );
            })}
          </nav>
          {query && (
            <span className="ml-auto flex items-center gap-1.5 rounded-md bg-sand-2 px-2 py-1 text-[12px] text-ink-2">
              Matching “{query}”
              <button onClick={() => setQuery('')} className="rounded text-ink-3 hover:text-ink" aria-label="Clear search"><X size={13} /></button>
            </span>
          )}
        </div>
        <p className="border-b border-line px-3 py-2 text-[13px] text-ink-3 sm:px-4">{view.blurb}</p>

        {picked.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-brand-100 bg-brand-50 px-4 py-2 text-[12px]">
            <span className="font-medium text-brand-900">{picked.length} selected</span>
            <span className="flex items-center gap-2">
              <button onClick={() => bulk('accepted')} className="flex items-center gap-1 rounded border border-line-dark bg-card px-2.5 py-1 font-medium text-ink hover:border-teal-500 hover:text-teal-800">
                <Check size={13} /> Accept suggestions
              </button>
              <button onClick={() => bulk('rejected')} className="flex items-center gap-1 rounded border border-line-dark bg-card px-2.5 py-1 font-medium text-ink hover:border-red-400 hover:text-red-800">
                <X size={13} /> Reject
              </button>
            </span>
          </div>
        )}

        <div className="thin-scroll overflow-x-auto px-3 sm:px-4">
          <table className="w-full min-w-[880px] border-collapse text-[14px]">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="w-10 py-3 pl-1">
                  <input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="Select all on page" className="accent-brand-600" />
                </th>
                {COLUMNS.map((c) => (
                  <th key={c.key} className={`py-3 pr-3 text-[13px] font-semibold whitespace-nowrap text-ink-2 ${c.wide ? 'hidden min-[1400px]:table-cell' : ''}`}>
                    <button onClick={() => toggleSort(c.key)} className="flex items-center gap-1 hover:text-ink">
                      {c.label}
                      {sort.key === c.key ? (sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} className="text-slate-300" />}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td colSpan={COLUMNS.length + 1} className="py-10 text-center text-ink-3">
                    {query ? `No ${view.label.toLowerCase()} tickets match “${query}”.` : `No ${view.label.toLowerCase()} tickets right now.`}
                  </td>
                </tr>
              )}
              {visible.map((t) => (
                <Row
                  key={t.ticket_id}
                  t={t}
                  checked={selected.has(t.ticket_id)}
                  onCheck={() => toggle(t.ticket_id)}
                  onDetails={() => setDetails(t)}
                  onReview={(v) => review(t.ticket_id, v, v === 'accepted' ? ['queue'] : undefined)}
                />
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-3 py-3 text-[13px] sm:px-4">
          <span className="text-ink-2">
            Showing <b className="tabular text-ink">{rows.length ? (cur - 1) * pageSize + 1 : 0}–{Math.min(cur * pageSize, rows.length)}</b> of <b className="tabular text-ink">{rows.length}</b>
          </span>
          <div className="flex items-center gap-1">
            <button disabled={cur === 1} onClick={() => setPage(cur - 1)} className="grid h-7 w-7 place-items-center rounded hover:bg-sand-2 disabled:opacity-30" aria-label="Previous page"><ChevronLeft size={15} /></button>
            {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
              <button key={p} onClick={() => setPage(p)} aria-current={p === cur ? 'page' : undefined} className={`tabular h-7 min-w-7 rounded px-1.5 ${p === cur ? 'bg-brand-800 font-semibold text-white' : 'hover:bg-sand-2'}`}>{p}</button>
            ))}
            <button disabled={cur === pages} onClick={() => setPage(cur + 1)} className="grid h-7 w-7 place-items-center rounded hover:bg-sand-2 disabled:opacity-30" aria-label="Next page"><ChevronRight size={15} /></button>
            <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }} aria-label="Rows per page" className="ml-3 h-7 rounded border border-line bg-card px-1.5 text-ink">
              {[10, 25, 50].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <span className="ml-1 text-ink-3">per page</span>
          </div>
        </div>
      </section>

      {details && <DetailsModal ticket={details} onClose={() => setDetails(null)} />}
    </div>
  );
}

function Row({ t, checked, onCheck, onDetails, onReview }) {
  const c = t.classification;
  const p1 = t.gate.reasons.filter((r) => r.severity === 'P1');
  const shown = (p1.length ? p1 : t.gate.reasons).slice(0, 1);
  return (
    <tr className={`border-b border-line/70 transition hover:bg-sand [&>td]:py-3.5 [&>td]:pr-3 ${checked ? 'bg-brand-50/70' : ''}`}>
      <td className="py-2.5 pl-1"><input type="checkbox" checked={checked} onChange={onCheck} aria-label={`Select ${t.ticket_id}`} className="accent-brand-600" /></td>
      <td className="py-2.5 pr-3 whitespace-nowrap">
        <a href={ticketHref(t.ticket_id)} className="font-mono text-[13px] font-medium text-brand-600 hover:underline">{t.ticket_id}</a>
        <div className="mt-0.5 text-[12px] text-ink-3">{timeAgo(t.created_at)}</div>
      </td>
      <td className="max-w-[320px] py-2.5 pr-3 min-[1400px]:max-w-[380px]">
        <span className="flex min-w-0 items-center gap-2">
          <LangBadge code={t.language.code} />
          <a href={ticketHref(t.ticket_id)} className="truncate font-medium text-ink hover:text-brand-700" title={t.subject}>{ticketTitle(t)}</a>
        </span>
        {t.gate.reasons.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {shown.map((r) => <ReasonChip key={r.code} code={r.code} />)}
            {t.gate.reasons.length > shown.length && <span className="text-[11px] text-ink-3">+{t.gate.reasons.length - shown.length}</span>}
          </div>
        )}
      </td>
      <td className="hidden py-2.5 pr-3 whitespace-nowrap text-ink-2 min-[1400px]:table-cell">{c.type.label}</td>
      <td className="py-2.5 pr-3"><PriorityBadge priority={c.priority.label} /></td>
      <td className="py-2.5 pr-3 whitespace-nowrap">
        <span className="flex items-center gap-1">
          <DecisionBadge decision={t.gate.decision} short />
          <button onClick={onDetails} title="Why this decision?" aria-label={`Why ${t.ticket_id} got this decision`} className="rounded p-1 text-ink-3 hover:bg-sand-2 hover:text-brand-700"><Sparkles size={14} /></button>
        </span>
      </td>
      <td className="py-2.5 pr-3">
        <span className="flex items-center gap-2">
          <span className={`max-w-[170px] leading-snug ${t.review === 'rejected' ? 'text-ink-3 line-through' : 'text-ink-2'}`}>{c.queue.label}</span>
          {t.review === 'pending' && (
            <span className="ml-auto flex gap-1">
              <button onClick={() => onReview('accepted')} title="Accept suggestion" aria-label={`Accept suggestion for ${t.ticket_id}`} className="grid h-6 w-6 place-items-center rounded border border-line bg-card hover:border-teal-500 hover:text-teal-700"><Check size={13} /></button>
              <button onClick={() => onReview('rejected')} title="Reject suggestion" aria-label={`Reject suggestion for ${t.ticket_id}`} className="grid h-6 w-6 place-items-center rounded border border-line bg-card hover:border-red-400 hover:text-red-700"><X size={13} /></button>
            </span>
          )}
          {t.review === 'accepted' && <Check size={13} className="text-teal-600" aria-label="Accepted" />}
        </span>
      </td>
      <td className="py-2.5 pr-3"><ConfidenceBar value={overallConfidence(t)} /></td>
    </tr>
  );
}
