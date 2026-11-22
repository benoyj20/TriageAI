import { useMemo, useState } from 'react';
import { Inbox, Layers, Loader2 } from 'lucide-react';
import { ConfidenceBar, LangBadge, PriorityBadge, ReasonChip } from '../components/Badges.jsx';
import { useTickets } from '../state/tickets.jsx';
import { PRIORITIES, WORKFLOW } from '../lib/constants.js';
import { overallConfidence, ticketTitle, timeAgo } from '../lib/format.js';
import { ticketHref } from '../lib/useHashRoute.js';
import PageHeader from '../components/PageHeader.jsx';

const COLUMN_ACCENT = {
  new: 'border-t-slate-300',
  escalated: 'border-t-red-600',
  review: 'border-t-amber-400',
  drafted: 'border-t-teal-500',
  resolved: 'border-t-slate-400',
};

const Chip = ({ active, onClick, children }) => (
  <button
    onClick={onClick}
    aria-pressed={active}
    className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition ${active ? 'bg-brand-800 text-white' : 'bg-card text-ink-2 ring-1 ring-line hover:bg-sand'}`}
  >
    {children}
  </button>
);

export default function KanbanBoard({ query, setQuery }) {
  const { tickets, pending, move, toast } = useTickets();
  const [prio, setPrio] = useState('all');
  const [lang, setLang] = useState('all');
  const [over, setOver] = useState(null);
  const [dragging, setDragging] = useState(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tickets
      .filter((t) => prio === 'all' || t.classification.priority.label === prio)
      .filter((t) => lang === 'all' || (lang === 'other' ? !['en', 'de'].includes(t.language.code) : t.language.code === lang))
      .filter((t) => !q || [t.ticket_id, t.subject, t.classification.queue.label].some((f) => f.toLowerCase().includes(q)))
      .sort((a, b) => (PRIORITIES[b.classification.priority.label]?.rank ?? 0) - (PRIORITIES[a.classification.priority.label]?.rank ?? 0) || b.created_at.localeCompare(a.created_at));
  }, [tickets, prio, lang, query]);

  const drop = (status, id) => {
    setOver(null);
    setDragging(null);
    const t = tickets.find((x) => x.ticket_id === id);
    if (!t || t.status === status) return;
    move(id, status);
    toast(`${id} → ${WORKFLOW.find((w) => w.id === status).label}`, status === 'resolved' ? 'good' : 'info');
  };

  return (
    <div className="flex h-full flex-col px-4 py-5 sm:px-6">
      <PageHeader
        title="Board"
        description="Every ticket by workflow stage. Drag a card, or use its Move menu, when work moves on."
        actions={<span className="text-[12.5px] text-ink-3">{filtered.length} shown</span>}
      />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {query && (
          <span className="flex items-center gap-1.5 rounded-md bg-sand-3/70 px-2 py-1 text-[12px] text-ink-2">
            Matching “{query}”
            <button onClick={() => setQuery('')} className="text-ink-3 hover:text-ink" aria-label="Clear search">×</button>
          </span>
        )}
        <span className="text-[12px] text-ink-3">Priority</span>
        {['all', 'high', 'medium', 'low'].map((p) => (
          <Chip key={p} active={prio === p} onClick={() => setPrio(p)}>{p === 'all' ? 'All' : PRIORITIES[p].label}</Chip>
        ))}
        <span className="ml-2 text-[12px] text-ink-3">Language</span>
        {[['all', 'All'], ['en', 'EN'], ['de', 'DE'], ['other', 'Other']].map(([v, l]) => (
          <Chip key={v} active={lang === v} onClick={() => setLang(v)}>{l}</Chip>
        ))}
      </div>

      <div className="thin-scroll mt-3 flex min-h-0 flex-1 gap-2.5 overflow-x-auto pb-2">
        {WORKFLOW.map((col) => {
          const cards = filtered.filter((t) => t.status === col.id);
          const inFlight = col.id === 'new' ? pending : [];
          const count = cards.length + inFlight.length;
          const isOver = over === col.id;
          const slim = count === 0 && !dragging;
          return (
            <section
              key={col.id}
              onDragOver={(e) => { e.preventDefault(); setOver(col.id); }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(null); }}
              onDrop={(e) => drop(col.id, e.dataTransfer.getData('text/plain'))}
              className={`flex flex-col rounded-lg border border-t-4 border-line ${slim ? 'w-[170px] shrink-0' : 'min-w-[240px] flex-1'} ${COLUMN_ACCENT[col.id]} ${isOver ? 'bg-brand-50 ring-2 ring-brand-600/30' : 'bg-sand-2/70'}`}
              aria-label={col.label}
            >
              <header className="flex items-center justify-between px-3 pt-2.5 pb-2">
                <div>
                  <h2 className="text-[13px] font-semibold">{col.label}</h2>
                  <p className="text-[11px] text-ink-3">{col.hint}</p>
                </div>
                <span className="tabular text-[12px] font-semibold text-ink-3">{count}</span>
              </header>
              <div className="thin-scroll flex min-h-[120px] flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                {inFlight.map((p) => (
                  <article key={p.key} aria-busy="true" className="rounded border border-dashed border-teal-300 bg-card p-2.5">
                    <div className="flex items-center gap-1.5 text-[11.5px] text-teal-700">
                      <Loader2 size={13} className="animate-spin" /> Triaging…
                    </div>
                    <div className="mt-1 line-clamp-2 text-[12.5px] font-medium text-ink-2">{p.subject}</div>
                  </article>
                ))}
                {count === 0 && (
                  <div className="mt-2 flex flex-col items-center gap-1 rounded border border-dashed border-slate-300 px-3 py-6 text-center text-[11.5px] text-ink-3">
                    {col.id === 'new' ? <Inbox size={18} /> : <Layers size={18} />}
                    {col.id === 'new' ? 'New tickets appear here while they are triaged.' : 'Drag a card here'}
                  </div>
                )}
                {cards.map((t) => (
                  <Card
                    key={t.ticket_id}
                    t={t}
                    dragging={dragging === t.ticket_id}
                    onDragStart={(e) => { e.dataTransfer.setData('text/plain', t.ticket_id); e.dataTransfer.effectAllowed = 'move'; setDragging(t.ticket_id); }}
                    onDragEnd={() => { setDragging(null); setOver(null); }}
                    onMove={(s) => drop(s, t.ticket_id)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Card({ t, dragging, onDragStart, onDragEnd, onMove }) {
  const c = t.classification;
  const p1 = t.gate.reasons.filter((r) => r.severity === 'P1');
  const shown = (p1.length ? p1 : t.gate.reasons).slice(0, 2);
  return (
    <article
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`cursor-grab rounded-md border border-line bg-card p-2.5 transition hover:border-line-dark active:cursor-grabbing ${dragging ? 'opacity-40' : ''} ${t.burst ? 'ring-1 ring-red-300' : ''}`}
    >
      <div className="flex items-center gap-1.5">
        <a href={ticketHref(t.ticket_id)} className="font-mono text-[12px] font-medium text-brand-600 hover:underline">{t.ticket_id}</a>
        <LangBadge code={t.language.code} />
        <span className="ml-auto"><PriorityBadge priority={c.priority.label} /></span>
      </div>
      <a href={ticketHref(t.ticket_id)} className="mt-1.5 line-clamp-2 block text-[12.5px] leading-snug font-medium text-ink hover:text-brand-700">{ticketTitle(t)}</a>
      <div className="mt-1 text-[11.5px] text-ink-2">{c.type.label} · {c.queue.label}</div>
      {shown.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {shown.map((r) => <ReasonChip key={r.code} code={r.code} />)}
          {t.gate.reasons.length > shown.length && <span className="text-[11px] text-ink-3">+{t.gate.reasons.length - shown.length}</span>}
        </div>
      )}
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-line/70 pt-1.5">
        <ConfidenceBar value={overallConfidence(t)} width="w-8" />
        <span className="text-[11px] whitespace-nowrap text-ink-3">{timeAgo(t.created_at)}</span>
        <select
          value=""
          onChange={(e) => e.target.value && onMove(e.target.value)}
          aria-label={`Move ${t.ticket_id} to another column`}
          className="h-6 w-[76px] shrink-0 rounded border border-line bg-card px-1 text-[11px] text-ink-2"
        >
          <option value="" disabled>Move to…</option>
          {WORKFLOW.filter((w) => w.id !== t.status).map((w) => <option key={w.id} value={w.id}>{w.short}</option>)}
        </select>
      </div>
    </article>
  );
}
