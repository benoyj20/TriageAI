import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, FileText, Lock, Send, ShieldAlert,
  Siren, Sparkles, ThumbsDown, ThumbsUp, TriangleAlert, UserCheck, XCircle,
} from 'lucide-react';
import { ConfidenceBar, DecisionBadge, LangBadge, Pill, PriorityBadge, StatusBadge } from '../components/Badges.jsx';
import DraftText from '../components/DraftText.jsx';
import PrecedentDrawer from '../components/PrecedentDrawer.jsx';
import LatencyStrip from '../components/LatencyStrip.jsx';
import { useTickets } from '../state/tickets.jsx';
import { DECISIONS, GATE_THRESHOLDS, LANGUAGES, PRIORITIES, REASONS } from '../lib/constants.js';
import { dateTime, pct, ticketTitle, timeAgo } from '../lib/format.js';
import { go, ticketHref } from '../lib/useHashRoute.js';

const DRAFT_MODE = {
  generated: { label: 'Generated', tone: 'bg-brand-100 text-brand-700' },
  extractive: { label: 'Extractive fallback', tone: 'bg-amber-100 text-amber-800' },
  holding: { label: 'Holding reply', tone: 'bg-sand-3 text-ink-2' },
};

function Section({ id, title, icon: Icon, right, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section id={id} className="scroll-mt-4 rounded border border-line bg-card">
      <header className="flex items-center gap-2 px-4 py-2.5">
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 text-[14px] font-semibold text-ink" aria-expanded={open}>
          {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          {Icon && <Icon size={15} className="text-brand-600" />}
          {title}
        </button>
        <div className="ml-auto">{right}</div>
      </header>
      {open && <div className="px-4 pb-4">{children}</div>}
    </section>
  );
}

function SideCard({ title, children }) {
  return (
    <section className="rounded border border-line bg-card px-3.5 py-3">
      {title && <h3 className="mb-2 text-[13.5px] font-semibold">{title}</h3>}
      {children}
    </section>
  );
}

function KV({ k, children }) {
  return (
    <div className="mb-2.5 last:mb-0">
      <div className="text-[11.5px] text-ink-3">{k}</div>
      <div className="mt-0.5 text-[12.5px]">{children}</div>
    </div>
  );
}

export default function TicketDetail({ id }) {
  const { tickets, byId, dispatch, move, review, toast, history } = useTickets();
  const t = byId(id);
  const [openSimilar, setOpenSimilar] = useState(null); // index into t.precedents
  const [highlight, setHighlight] = useState(null); // precedent id to flash in the draft

  useEffect(() => {
    setOpenSimilar(null);
    setHighlight(null);
  }, [id]);

  useEffect(() => {
    if (!highlight) return undefined;
    const timer = setTimeout(() => setHighlight(null), 3000);
    return () => clearTimeout(timer);
  }, [highlight]);

  const ordered = useMemo(() => [...tickets].sort((a, b) => b.created_at.localeCompare(a.created_at)), [tickets]);
  const idx = ordered.findIndex((x) => x.ticket_id === id);

  useEffect(() => {
    if (t) dispatch({ type: 'VISIT', id });
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!t) {
    return (
      <div className="p-10 text-center">
        <p className="text-[14px] font-medium">Ticket {id} isn't in this session.</p>
        <a href="#/console" className="mt-2 inline-block text-brand-600 hover:underline">Back to the dashboard</a>
      </div>
    );
  }

  const c = t.classification;
  // A gated draft stays held until a person accepts the triage; a draft that failed validation never sends.
  const held = t.gate.decision !== 'AUTO_DRAFT' && t.review !== 'accepted';
  const invalid = !t.draft.validation.passed;
  const sendBlocked = invalid
    ? 'This draft failed validation and cannot be sent. Write the reply by hand or escalate.'
    : held
      ? 'Held for review. Accept the triage suggestions below to release the draft.'
      : null;
  const activity = history.filter((h) => h.id === t.ticket_id).slice(0, 6);

  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(t.draft.text);
      toast('Draft copied to clipboard', 'good');
    } catch {
      toast('Clipboard is blocked in this browser', 'critical');
    }
  };
  const openCited = (pid) => {
    const i = t.precedents.findIndex((p) => p.ticket_id === pid);
    if (i !== -1) setOpenSimilar(i);
  };
  const showInDraft = (pid) => {
    setOpenSimilar(null);
    setHighlight(pid);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => document.getElementById('reply-draft')?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' }));
  };
  const act = (status, msg, tone = 'info') => {
    move(t.ticket_id, status);
    toast(msg, tone);
  };

  return (
    <div className="flex min-h-full flex-col">
      {/* Title bar */}
      <div className="flex items-center gap-3 border-b border-line bg-card px-4 py-2.5">
        <a href="#/console" className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[12.5px] text-ink-3 hover:text-ink" title="Back to Overview"><ArrowLeft size={15} /> <span className="hidden sm:inline">Overview</span></a>
        <h1 className="flex min-w-0 items-baseline gap-2 text-[15px] font-semibold text-ink">
          <span className="shrink-0 font-mono text-[13px] font-medium text-brand-600">{t.ticket_id}</span>
          <span className="truncate">{ticketTitle(t)}</span>
        </h1>
        <div className="ml-auto flex shrink-0 items-center gap-1 text-[12.5px] text-ink-2">
          <button disabled={idx <= 0} onClick={() => go(ticketHref(ordered[idx - 1].ticket_id))} className="rounded p-1 hover:bg-sand-2 disabled:opacity-30" aria-label="Previous ticket"><ChevronLeft size={16} /></button>
          <span className="tabular">{idx + 1} of {ordered.length}</span>
          <button disabled={idx >= ordered.length - 1} onClick={() => go(ticketHref(ordered[idx + 1].ticket_id))} className="rounded p-1 hover:bg-sand-2 disabled:opacity-30" aria-label="Next ticket"><ChevronRight size={16} /></button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-card px-4 py-1.5">
        <ToolButton
          icon={Send}
          onClick={() => act('resolved', `Reply sent for ${t.ticket_id}`, 'good')}
          disabled={t.status === 'resolved' || Boolean(sendBlocked)}
          title={sendBlocked ?? 'Send the reply and resolve the ticket'}
        >Send draft</ToolButton>
        <ToolButton icon={UserCheck} onClick={() => act('review', `${t.ticket_id} sent to human review`)} disabled={t.status === 'review'}>Send to review</ToolButton>
        <ToolButton icon={Siren} onClick={() => act('escalated', `${t.ticket_id} escalated to on-call`, 'critical')} disabled={t.status === 'escalated'}>Escalate</ToolButton>
        <ToolButton icon={Copy} onClick={copyDraft}>Copy draft</ToolButton>
        <ToolButton icon={CheckCircle2} onClick={() => act('resolved', `${t.ticket_id} closed`, 'good')} disabled={t.status === 'resolved'}>Close</ToolButton>
        <span className="ml-auto"><StatusBadge status={t.status} /></span>
      </div>

      <div className="grid flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-[230px_minmax(0,1fr)_280px]">
        {/* Left */}
        <aside className="space-y-3">
          <SideCard>
            <KV k="Language"><span className="flex items-center gap-1.5"><LangBadge code={t.language.code} /> {LANGUAGES[t.language.code] ?? t.language.code} <span className="text-ink-3">{pct(t.language.confidence)}</span></span></KV>
            <KV k="Status"><StatusBadge status={t.status} /></KV>
            <KV k="Priority"><PriorityBadge priority={c.priority.label} /></KV>
            <KV k="Gate decision"><DecisionBadge decision={t.gate.decision} /></KV>
          </SideCard>
          <SideCard title="Classification">
            <KV k="Type"><div className="flex items-center justify-between gap-2"><span>{c.type.label}</span><ConfidenceBar value={c.type.confidence} width="w-10" /></div>
              <TopProbs probs={c.type.probs} label={c.type.label} /></KV>
            <KV k="Queue"><div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate" title={c.queue.label}>{c.queue.label}</span><ConfidenceBar value={c.queue.confidence} width="w-10" /></div>
              <div className="text-[11px] text-ink-3">{c.queue.votes}/{c.queue.k} retrieval votes agree</div>
              <TopProbs probs={c.queue.probs} label={c.queue.label} /></KV>
            <KV k="Priority"><div className="flex items-center justify-between gap-2"><span>{PRIORITIES[c.priority.label]?.label}</span><ConfidenceBar value={c.priority.confidence} width="w-10" /></div>
              <div className="text-[11px] text-ink-3">P(high) = {c.priority.p_high.toFixed(2)}</div>
              <TopProbs probs={c.priority.probs} label={c.priority.label} format={(k) => PRIORITIES[k]?.label ?? k} /></KV>
          </SideCard>
          <SideCard title="Gateway">
            <div className="flex items-start gap-2 text-[12px] text-ink-2">
              <Lock size={14} className="mt-px shrink-0 text-brand-600" />
              {t.pii?.masked?.length ? (
                <span>PII masked before the engine: {t.pii.masked.map((m) => `${m.count} ${m.type.toLowerCase()}`).join(', ')}</span>
              ) : (
                <span>No PII found in the subject or body.</span>
              )}
            </div>
          </SideCard>
        </aside>

        {/* Center */}
        <div className="min-w-0 space-y-3">
          <section className="flex gap-4 rounded border border-line bg-card px-4 py-3.5">
            <FileText size={34} strokeWidth={1.4} className="shrink-0 text-brand-600" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Pill className="rounded bg-brand-600 text-white">{c.type.label}</Pill>
                <span className="text-[12.5px] text-ink-2">{c.queue.label}</span>
              </div>
              <div className="mt-1 text-[12px] text-ink-3">
                {t.ticket_id}
                {t.request_id && <span className="ml-2 font-mono text-[11px]" title="Request ID, for the gateway and engine logs">{t.request_id}</span>}
              </div>
              <h2 className="mt-1 text-[17px] font-semibold">{ticketTitle(t)}</h2>
              <div className="mt-1 text-[12px] text-ink-2">
                <b>Created</b> {dateTime(t.created_at)} <span className="mx-1 text-ink-3">·</span> <b>Triaged</b> {timeAgo(t.processed_at)}
              </div>
            </div>
          </section>

          <Suggestions key={t.ticket_id} t={t} review={review} toast={toast} />

          <Section title={`Escalation gate (${t.gate.reasons.length})`} icon={ShieldAlert} right={<DecisionBadge decision={t.gate.decision} />}>
            {t.gate.reasons.length === 0 ? (
              <p className="flex items-center gap-2 text-[12.5px] text-emerald-800"><CheckCircle2 size={15} /> No reasons fired. The grounded draft can go out after a quick check.</p>
            ) : (
              <ul className="space-y-1.5">
                {t.gate.reasons.map((r) => (
                  <li key={r.code} className={`flex items-start gap-2.5 rounded border px-3 py-2 ${r.severity === 'P1' ? 'border-red-200 bg-red-50/60' : 'border-amber-200 bg-amber-50/60'}`}>
                    {r.severity === 'P1' ? <ShieldAlert size={15} className="mt-px text-red-700" /> : <TriangleAlert size={15} className="mt-px text-amber-700" />}
                    <div className="min-w-0">
                      <div className="text-[12.5px]"><b>{r.severity} · {REASONS[r.code]?.label ?? r.code}</b> <code className="ml-1 text-[11px] text-ink-3">{r.code}</code></div>
                      <div className="text-[12px] text-ink-2">{r.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Description" icon={null}>
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{t.body}</p>
          </Section>

          <Section
            id="reply-draft"
            title="Reply draft"
            icon={Sparkles}
            right={
              <span className="flex items-center gap-2">
                <LangBadge code={t.draft.language} />
                <Pill className={DRAFT_MODE[t.draft.mode].tone}>{DRAFT_MODE[t.draft.mode].label}</Pill>
              </span>
            }
          >
            {invalid ? (
              <div className="mb-3 flex items-start gap-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-900">
                <XCircle size={14} className="mt-px shrink-0" />
                Blocked: this draft failed validation and cannot be sent. Write the reply by hand or escalate.
              </div>
            ) : held ? (
              <div className="mb-3 flex items-start gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
                <Lock size={14} className="mt-px shrink-0" />
                Held: {DECISIONS[t.gate.decision].method.toLowerCase()}. Accept the triage suggestions to release this draft for sending.
              </div>
            ) : t.gate.decision !== 'AUTO_DRAFT' && (
              <div className="mb-3 flex items-start gap-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-900">
                <CheckCircle2 size={14} className="mt-px shrink-0" />
                Released: a person accepted the triage. Check the draft before sending.
              </div>
            )}
            <div className="rounded border border-line bg-sand/70 px-4 py-3">
              <DraftText text={t.draft.text} known={t.precedents.map((p) => p.ticket_id)} onCite={openCited} highlight={highlight} />
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-3 text-[12px]">
              <Check2 ok={t.draft.validation.citations_ok}>Citations resolve</Check2>
              <Check2 ok={t.draft.validation.numbers_ok}>Numbers grounded</Check2>
              <Check2 ok={t.draft.validation.language_ok}>Reply language</Check2>
              {t.draft.validation.retries > 0 && <span className="text-ink-3">{t.draft.validation.retries} {t.draft.validation.retries > 1 ? 'retries' : 'retry'}</span>}
              <span className="ml-auto flex items-center gap-1">
                <span className="mr-1 text-[11.5px] text-ink-3">Was this draft helpful?</span>
                <FeedbackButton t={t} dispatch={dispatch} value="up" />
                <FeedbackButton t={t} dispatch={dispatch} value="down" />
              </span>
              <button onClick={copyDraft} className="flex items-center gap-1 rounded border border-line px-2 py-1 hover:bg-sand"><Copy size={13} /> Copy</button>
            </div>
            {t.draft.validation.issues.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-[12px] text-red-800">
                {t.draft.validation.issues.map((i) => <li key={i}>{i}</li>)}
              </ul>
            )}
          </Section>

          <section className="rounded border border-line bg-card px-4 py-3">
            <LatencyStrip latency={t.latency_ms} />
            {t.warnings.length > 0 && (
              <details className="mt-2.5 text-[12px]">
                <summary className="cursor-pointer text-amber-800">{t.warnings.length} engine warning{t.warnings.length > 1 ? 's' : ''}</summary>
                <ul className="mt-1 space-y-1 pl-4">
                  {t.warnings.map((w, i) => (
                    <li key={i} className="list-disc text-ink-2"><code className="text-[11px] text-ink-3">{w.stage} · {w.code}</code> {w.message}</li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        </div>

        {/* Right */}
        <aside className="space-y-3">
          <SideCard
            title={
              <span className="flex items-baseline justify-between gap-2">
                Similar tickets
                {t.precedents.length > 0 && <span className="text-[11.5px] font-normal text-ink-3">{t.precedents.length} found</span>}
              </span>
            }
          >
            {t.precedents.length === 0 ? (
              <p className="rounded border border-dashed border-line px-3 py-4 text-center text-[12px] text-ink-3">
                No similar ticket in the knowledge base. The draft is a holding reply that promises nothing.
              </p>
            ) : (
              <>
                <ul className="-mx-1.5 space-y-0.5">
                  {t.precedents.map((p, i) => {
                    const cite = t.draft.citations.indexOf(p.ticket_id);
                    const on = openSimilar === i;
                    return (
                      <li key={p.ticket_id}>
                        <button
                          type="button"
                          onClick={() => setOpenSimilar(i)}
                          aria-haspopup="dialog"
                          className={`group grid w-full grid-cols-[1fr_auto] items-center gap-x-2 rounded-md border px-2 py-2 text-left transition outline-none focus-visible:ring-2 focus-visible:ring-brand-600/40 ${
                            on ? 'border-brand-600/40 bg-brand-50' : 'border-transparent hover:border-brand-100 hover:bg-sand'
                          }`}
                        >
                          <span className="min-w-0">
                            <span className="flex items-center gap-1.5 text-[11.5px]">
                              <span className="font-mono font-medium text-brand-600">{p.ticket_id}</span>
                              {cite !== -1 && <span className="font-medium text-teal-700">cited [c{cite}]</span>}
                            </span>
                            <span className="mt-0.5 block text-[12.5px] leading-snug font-medium text-ink">{p.subject}</span>
                            <span className="mt-1 flex items-center gap-2">
                              <ConfidenceBar value={p.similarity} width="w-12" />
                              <LangBadge code={p.language} />
                            </span>
                          </span>
                          <ChevronRight size={15} className="text-slate-400 transition group-hover:text-brand-600" aria-hidden />
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-2 text-[11.5px] text-ink-3">Open one to see how it was resolved.</p>
              </>
            )}
            <details className="mt-3 border-t border-line pt-2 text-[12px]">
              <summary className="cursor-pointer text-ink-2 hover:text-ink">Where these came from</summary>
              <div className="mt-2"><RoutingPath route={t.retrieval.route} found={t.precedents.length} /></div>
            </details>
          </SideCard>
          <SideCard title="Activity">
            {activity.length === 0 ? (
              <p className="text-[12px] text-ink-3">No activity yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {activity.map((h, i) => (
                  <li key={i} className="text-[12px]">
                    <div>{h.text}</div>
                    <div className="text-[11px] text-ink-3">{timeAgo(h.at)}</div>
                  </li>
                ))}
              </ul>
            )}
          </SideCard>
        </aside>
      </div>
      {openSimilar != null && t.precedents[openSimilar] && (
        <PrecedentDrawer
          ticket={t}
          precedents={t.precedents}
          index={openSimilar}
          setIndex={setOpenSimilar}
          onClose={() => setOpenSimilar(null)}
          onHighlight={showInDraft}
          toast={toast}
        />
      )}
    </div>
  );
}

function ToolButton({ icon: Icon, children, ...rest }) {
  return (
    <button {...rest} className="flex items-center gap-1.5 rounded border border-line bg-card px-2.5 py-1 text-[12px] hover:bg-sand disabled:opacity-40">
      <Icon size={13} /> {children}
    </button>
  );
}

// FS-09: level 1 scores the queues, level 2 searches tickets inside the chosen ones; weak matches fall
// back to a search across all queues.
function RoutingPath({ route, found }) {
  if (!route.queues.length && !route.fallback_global) return null;
  return (
    <div className="mb-2.5 rounded border border-line bg-sand px-2.5 py-2 text-[11.5px]">
      <div className="mb-1 font-medium text-ink-2">Routing path</div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-ink-3">Knowledge base</span>
        <ChevronRight size={12} className="text-ink-3" aria-hidden />
        {route.queues.map((q) => {
          const searched = route.searched.includes(q.queue);
          return (
            <span
              key={q.queue}
              title={searched ? 'Searched for precedents' : 'Scored, not searched'}
              className={`rounded px-1.5 py-0.5 ${searched ? 'bg-brand-100 text-brand-800' : 'bg-sand-3 text-ink-3'}`}
            >
              {q.queue}{q.score != null && <span className="ml-1 text-ink-3">{q.score.toFixed(2)}</span>}
            </span>
          );
        })}
      </div>
      {route.fallback_global ? (
        <p className="mt-1 text-amber-800">
          {found ? 'The routed queues matched weakly, so precedents came from all queues.' : 'The routed queues matched weakly, and a search across all queues found nothing similar either.'}
        </p>
      ) : (
        <p className="mt-1 text-ink-3">Precedents were searched inside the highlighted {route.searched.length > 1 ? 'queues' : 'queue'}.</p>
      )}
    </div>
  );
}

// Top three classes of one classifier head, as thin bars (the label's own bar is highlighted).
function TopProbs({ probs, label, format = (k) => k }) {
  const top = Object.entries(probs).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (top.length < 2) return null;
  return (
    <ul className="mt-1 space-y-0.5" aria-label="Top classes">
      {top.map(([k, p]) => (
        <li key={k} className="flex items-center gap-1.5 text-[10.5px] text-ink-3">
          <span className="w-24 truncate" title={format(k)}>{format(k)}</span>
          <span className="h-1 flex-1 rounded bg-sand-2">
            <span className={`block h-1 rounded ${k === label ? 'bg-brand-600' : 'bg-slate-300'}`} style={{ width: `${Math.round(p * 100)}%` }} />
          </span>
          <span className="tabular w-7 text-right">{Math.round(p * 100)}%</span>
        </li>
      ))}
    </ul>
  );
}

function FeedbackButton({ t, dispatch, value }) {
  const on = t.feedback === value;
  const Icon = value === 'up' ? ThumbsUp : ThumbsDown;
  return (
    <button
      onClick={() => dispatch({ type: 'FEEDBACK', id: t.ticket_id, value })}
      aria-pressed={on}
      aria-label={value === 'up' ? 'Draft helpful' : 'Draft not helpful'}
      className={`rounded p-1.5 ${on ? (value === 'up' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700') : 'text-ink-3 hover:bg-sand-2'}`}
    ><Icon size={14} /></button>
  );
}

function Check2({ ok, children }) {
  return (
    <span className={`flex items-center gap-1 ${ok ? 'text-emerald-700' : 'text-red-700'}`}>
      {ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />} {children}
    </span>
  );
}

// "Ticket Triage Suggestions" — pick which suggested fields to apply.
function Suggestions({ t, review, toast }) {
  const c = t.classification;
  const fields = [
    { id: 'queue', group: 'Routing', label: 'Queue', value: c.queue.label, conf: c.queue.confidence },
    { id: 'decision', group: 'Routing', label: 'Gate', value: DECISIONS[t.gate.decision].label, conf: null },
    { id: 'type', group: 'Ticket information', label: 'Type', value: c.type.label, conf: c.type.confidence },
    { id: 'priority', group: 'Ticket information', label: 'Priority', value: PRIORITIES[c.priority.label]?.label, conf: c.priority.confidence },
  ];
  const [picked, setPicked] = useState(() => new Set(t.applied ?? fields.filter((f) => f.conf == null || f.conf >= GATE_THRESHOLDS.confidenceFloor).map((f) => f.id)));
  const done = t.review === 'accepted' || t.review === 'rejected';

  const apply = () => {
    if (picked.size === 0) {
      review(t.ticket_id, 'rejected');
      toast('All suggestions rejected', 'info');
    } else {
      review(t.ticket_id, 'accepted', [...picked]);
      toast(`Applied ${picked.size} suggestion${picked.size > 1 ? 's' : ''}`, 'good');
    }
  };
  const flip = (id) => setPicked((s) => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  return (
    <Section title={`Ticket triage suggestions (${fields.length})`} icon={Sparkles}>
      <p className="mb-2 text-[12px] text-ink-2">Select the fields to apply, then click Apply. Fields you leave unselected are rejected.</p>
      {['Routing', 'Ticket information'].map((g) => (
        <div key={g} className="mb-2">
          <div className="mb-1 text-[12px] font-semibold">{g}</div>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {fields.filter((f) => f.group === g).map((f) => (
              <label key={f.id} className={`flex items-center gap-2 text-[12.5px] ${done ? 'opacity-70' : 'cursor-pointer'}`}>
                <input type="checkbox" disabled={done} checked={picked.has(f.id)} onChange={() => flip(f.id)} className="accent-brand-600" />
                <span>{f.label}: <b>{f.value}</b></span>
                {f.conf != null && <span className={`text-[11px] ${f.conf < GATE_THRESHOLDS.confidenceFloor ? 'text-red-700' : 'text-ink-3'}`}>{pct(f.conf)}</span>}
                {t.review === 'accepted' && t.applied?.includes(f.id) && <span className="text-[11px] text-emerald-700">Applied</span>}
              </label>
            ))}
          </div>
        </div>
      ))}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {done ? (
          <span className={`flex items-center gap-1.5 text-[12.5px] font-medium ${t.review === 'accepted' ? 'text-emerald-700' : 'text-ink-2'}`}>
            {t.review === 'accepted' ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
            Suggestions {t.review}
            <button onClick={() => review(t.ticket_id, 'pending')} className="ml-2 text-[12px] font-normal text-brand-600 hover:underline">Undo</button>
          </span>
        ) : (
          <>
            <button onClick={apply} className="flex items-center gap-1.5 rounded border border-line bg-card px-2.5 py-1 text-[12px] font-medium hover:bg-sand"><Check size={13} /> Apply</button>
            <button onClick={() => setPicked(new Set(fields.map((f) => f.id)))} className="rounded border border-line px-2.5 py-1 text-[12px] hover:bg-sand">Select all</button>
            <button onClick={() => setPicked(new Set())} className="rounded border border-line px-2.5 py-1 text-[12px] hover:bg-sand">Deselect all</button>
          </>
        )}
      </div>
    </Section>
  );
}
