import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowLeftRight,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Copy,
  CreditCard,
  Inbox,
  KeyRound,
  Laptop,
  Loader2,
  Lock,
  Mail,
  MessageSquareText,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
  Wifi,
  Zap,
} from 'lucide-react';
import { api } from '../api/client.js';
import { describeError } from '../api/normalize.js';
import { myTicketHref } from '../lib/useHashRoute.js';
import CreatorTicket from '../components/creator/CreatorTicket.jsx';
import RelatedReading from '../components/creator/RelatedReading.jsx';
import { STATUS, StatusPill, readMine, when, writeMine } from '../components/creator/status.jsx';
import './help.css';

// Ticket creator view: submit a problem, follow your own tickets, read how similar issues were solved.
// No triage internals are shown here.

const MAX_BODY = 10_000;

// Quick starts: pick a topic to pre-fill the subject and get a tailored prompt.
const TOPICS = [
  {
    id: 'vpn',
    icon: Wifi,
    label: 'VPN / network',
    subject: 'VPN not connecting',
    hint: 'Which network or location? Any error message? Since when?',
  },
  {
    id: 'password',
    icon: KeyRound,
    label: 'Login / password',
    subject: 'Cannot sign in',
    hint: 'Which system? Did a reset email arrive? Is your account locked?',
  },
  { id: 'email', icon: Mail, label: 'Email', subject: 'Email problem', hint: 'Sending, receiving or sync? On which device or client?' },
  {
    id: 'hardware',
    icon: Laptop,
    label: 'Device / hardware',
    subject: 'Device issue',
    hint: 'Which device and model? What happens when you try to use it?',
  },
  {
    id: 'billing',
    icon: CreditCard,
    label: 'Billing',
    subject: 'Billing question',
    hint: 'Which invoice or charge? What did you expect to see?',
  },
  {
    id: 'security',
    icon: ShieldAlert,
    label: 'Security concern',
    subject: 'Possible security incident',
    hint: 'What did you notice, when, and which systems or files are affected?',
  },
];

const STEPS = [
  { icon: Send, title: 'You submit', body: 'Describe the issue in your own words.' },
  { icon: Zap, title: 'Sorted in seconds', body: 'Routed to the right team by urgency.' },
  { icon: UserCheck, title: 'People stay in charge', body: 'A specialist checks before anything is sent.' },
  { icon: MessageSquareText, title: 'You get a reply', body: 'Grounded in past fixes, in your language.' },
];

function TicketRow({ t }) {
  const s = STATUS[t.status] ?? STATUS.new;
  return (
    <li className="help-ticket" style={{ '--status': s.bar }}>
      <a
        href={myTicketHref(t.ticket_id)}
        title="Open ticket"
        className="block px-5 py-4 outline-none transition hover:bg-sand/60 focus-visible:bg-sand/60 focus-visible:ring-2 focus-visible:ring-teal-400 focus-visible:ring-inset sm:pl-6"
      >
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-medium text-ink">{t.subject || 'Untitled'}</p>
            <p className="mt-0.5 text-[12px] text-ink-3">
              <span className="font-mono">{t.ticket_id}</span> ·{' '}
              {t.status === 'resolved' && t.updated_at ? `resolved ${when(t.updated_at)}` : when(t.created_at)}
            </p>
          </div>
          <StatusPill status={t.status} />
          <ChevronRight size={16} className="shrink-0 text-ink-3" aria-hidden />
        </div>
        <div className="mt-3 flex items-center gap-3" aria-hidden>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-line">
            <div className="help-track-fill h-full rounded-full" style={{ background: s.bar, transform: `scaleX(${s.fill})` }} />
          </div>
          <span className="hidden w-[150px] justify-between text-[10.5px] font-medium tracking-wide text-ink-3 uppercase sm:flex">
            <span className={s.fill >= 0.18 ? 'text-ink-2' : ''}>Received</span>
            <span className={s.fill >= 0.5 ? 'text-ink-2' : ''}>Handling</span>
            <span className={s.fill >= 1 ? 'text-ink-2' : ''}>Done</span>
          </span>
        </div>
      </a>
    </li>
  );
}

export default function CreatorPortal({ ticketId }) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [topic, setTopic] = useState(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null); // the ticket just submitted
  const [mine, setMine] = useState(readMine);
  const [copied, setCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Refresh the status of the creator's own tickets (and only those).
  const refresh = useCallback(async () => {
    const items = readMine();
    if (!items.length) return;
    const updated = await Promise.all(
      items.map(async (t) => {
        try {
          const s = await api.ticketStatus(t.ticket_id);
          return { ...t, status: s.status, updated_at: s.updated_at };
        } catch (err) {
          // 404: the store doesn't know this ticket, so don't keep showing a stale status. Other errors: keep the last one.
          return err?.status === 404 ? { ...t, status: 'missing' } : t;
        }
      }),
    );
    writeMine(updated);
    setMine(updated);
  }, []);

  useEffect(() => {
    if (ticketId) return undefined; // the ticket view polls its own ticket
    setMine(readMine()); // pick up statuses the ticket view saw
    refresh();
    const id = setInterval(() => !document.hidden && refresh(), 10_000);
    return () => clearInterval(id);
  }, [refresh, ticketId]);

  // Tickets the store no longer has (expired after 7 days, or sent before tracking began).
  const removeMissing = () => {
    const next = readMine().filter((t) => t.status !== 'missing');
    writeMine(next);
    setMine(next);
  };

  const manualRefresh = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  // Picking a topic fills the subject only if the user hasn't typed their own.
  const pickTopic = (t) => {
    const prev = TOPICS.find((x) => x.id === topic);
    const untouched = !subject.trim() || subject === prev?.subject;
    if (topic === t.id) {
      setTopic(null);
      if (untouched) setSubject('');
      return;
    }
    setTopic(t.id);
    if (untouched) setSubject(t.subject);
    document.getElementById('help-body')?.focus();
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!body.trim() || sending) return;
    setSending(true);
    setError('');
    try {
      const t = await api.triage({ subject: subject.trim() || null, body: body.trim() });
      const entry = {
        ticket_id: t.ticket_id,
        subject: subject.trim() || body.trim().slice(0, 80),
        created_at: t.created_at,
        status: { ESCALATE_ONCALL: 'escalated', HUMAN_REVIEW: 'review', AUTO_DRAFT: 'drafted' }[t.gate.decision] ?? 'new',
      };
      const next = [entry, ...readMine().filter((x) => x.ticket_id !== entry.ticket_id)];
      writeMine(next);
      setMine(next);
      setDone(entry);
      setSubject('');
      setBody('');
      setTopic(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSending(false);
    }
  };

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(done.ticket_id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the id is visible anyway */
    }
  };

  const activeTopic = TOPICS.find((x) => x.id === topic);
  const openCount = mine.filter((t) => t.status !== 'resolved' && t.status !== 'missing').length;
  const nearLimit = body.length > MAX_BODY * 0.9;

  return (
    <div className="thin-scroll h-full overflow-y-auto bg-page">
      {/* Hero */}
      <div className={`help-hero text-white ${ticketId ? 'pb-24' : 'pb-28 sm:pb-32'}`}>
        <header className="mx-auto flex h-16 max-w-6xl items-center gap-2.5 px-4 sm:px-6">
          <a href="#/" className="flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-teal-300">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-teal-500 text-brand-950">
              <ShieldCheck size={19} strokeWidth={2.4} aria-hidden />
            </span>
            <span className="text-[16px] font-bold tracking-tight">
              SentinelDesk <span className="font-medium text-slate-400">Support</span>
            </span>
          </a>
          <a
            href="#/"
            title="Switch role"
            className="ml-auto flex h-9 items-center gap-1.5 rounded-lg border border-white/15 px-3 text-[13px] font-medium text-slate-200 transition hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-teal-300 focus-visible:outline-none"
          >
            <ArrowLeftRight size={14} aria-hidden />
            <span className="hidden sm:inline">Switch role</span>
          </a>
        </header>

        {ticketId ? (
          <div className="mx-auto max-w-6xl px-4 pt-6 sm:px-6">
            <a
              href="#/help"
              className="inline-flex items-center gap-1.5 rounded-md text-[13px] font-medium text-slate-300 outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-teal-300"
            >
              <ArrowLeft size={14} aria-hidden /> Your tickets
            </a>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl px-4 pt-8 text-center sm:px-6 sm:pt-12">
            <span className="help-rise inline-flex items-center gap-2 rounded-full border border-teal-300/25 bg-teal-300/10 px-3 py-1 text-[12px] font-medium text-teal-200">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse-dot" aria-hidden />
              Support is online · on-call team for urgent issues
            </span>
            <h1
              className="help-rise mt-5 text-[32px] leading-[1.1] font-bold tracking-tight text-balance sm:text-[44px]"
              style={{ animationDelay: '60ms' }}
            >
              How can we <span className="help-gradient-text">help today?</span>
            </h1>
            <p
              className="help-rise mx-auto mt-3 max-w-[46ch] text-[15px] leading-relaxed text-slate-300"
              style={{ animationDelay: '120ms' }}
            >
              Tell us what's wrong. Your ticket is sorted in seconds and goes straight to the people who can fix it.
            </p>
            <ul
              className="help-rise mt-6 flex flex-wrap justify-center gap-x-5 gap-y-2 text-[12.5px] text-slate-300"
              style={{ animationDelay: '180ms' }}
            >
              <li className="flex items-center gap-1.5">
                <Lock size={14} className="text-teal-300" aria-hidden /> Personal data masked
              </li>
              <li className="flex items-center gap-1.5">
                <Zap size={14} className="text-teal-300" aria-hidden /> Urgent issues page on-call
              </li>
            </ul>
          </div>
        )}
      </div>

      <main
        className={`relative mx-auto space-y-10 px-4 pb-16 sm:px-6 ${ticketId || done ? 'max-w-6xl' : 'max-w-3xl'} ${ticketId ? '-mt-16' : '-mt-20 sm:-mt-24'}`}
      >
        {ticketId ? (
          <CreatorTicket id={ticketId} />
        ) : (
          <>
            {/* Form, or the success card with readings that may solve it on the right */}
            <div className={done ? 'grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px]' : ''}>
              <section className="help-card help-rise rounded-2xl p-5 sm:p-8" style={{ animationDelay: '220ms' }}>
                {done ? (
                  <div className="lab-in py-6 text-center">
                    <div className="help-success-ring mx-auto grid h-16 w-16 place-items-center rounded-full bg-emerald-50 text-emerald-600 ring-8 ring-emerald-50/60">
                      <CheckCircle2 size={34} aria-hidden />
                    </div>
                    <h2 className="mt-5 text-[22px] font-semibold tracking-tight text-ink">Ticket submitted</h2>
                    <p className="mx-auto mt-1.5 max-w-sm text-[14px] text-ink-2">
                      Our support team is on it. Keep this ID for reference and follow progress below.
                    </p>
                    <button
                      onClick={copyId}
                      title="Copy ticket ID"
                      className="mx-auto mt-5 flex items-center gap-2 rounded-lg border border-line bg-page px-3.5 py-2 font-mono text-[13.5px] text-ink-2 transition hover:border-teal-400 hover:bg-teal-50/50"
                    >
                      {done.ticket_id} <Copy size={13} aria-hidden /> <span className="sr-only">Copy</span>
                      {copied && <span className="font-sans text-[12px] text-emerald-700">Copied</span>}
                    </button>
                    <div className="mt-6 flex justify-center">
                      <StatusPill status={done.status} />
                    </div>
                    <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
                      <a
                        href={myTicketHref(done.ticket_id)}
                        className="inline-flex h-10 items-center gap-2 rounded-lg border border-line-dark bg-card px-4 text-[13.5px] font-semibold text-ink-2 transition hover:border-teal-400 focus-visible:ring-2 focus-visible:ring-teal-400 focus-visible:outline-none"
                      >
                        View ticket
                      </a>
                      <button
                        onClick={() => setDone(null)}
                        className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-950 px-4 text-[13.5px] font-semibold text-white transition hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-teal-400 focus-visible:outline-none"
                      >
                        <Send size={15} aria-hidden /> Submit another ticket
                      </button>
                    </div>
                  </div>
                ) : (
                  <form onSubmit={submit} className="space-y-5">
                    <div>
                      <p className="text-[12px] font-semibold tracking-wide text-teal-700 uppercase">New ticket</p>
                      <h2 className="mt-1 text-[20px] font-semibold tracking-tight text-ink">What do you need help with?</h2>
                    </div>

                    <div role="group" aria-label="Common topics" className="flex flex-wrap gap-2">
                      {TOPICS.map((t) => {
                        const Icon = t.icon;
                        return (
                          <button
                            key={t.id}
                            type="button"
                            aria-pressed={topic === t.id}
                            onClick={() => pickTopic(t)}
                            className="help-chip flex items-center gap-1.5 rounded-full border border-line-dark bg-card px-3 py-1.5 text-[12.5px] font-medium text-ink-2 hover:border-teal-400 focus-visible:ring-2 focus-visible:ring-teal-400 focus-visible:outline-none"
                          >
                            <Icon size={14} className={topic === t.id ? 'text-teal-600' : 'text-ink-3'} aria-hidden />
                            {t.label}
                          </button>
                        );
                      })}
                    </div>

                    <label className="block">
                      <span className="text-[13px] font-medium text-ink-2">
                        Subject <span className="font-normal text-ink-3">(optional)</span>
                      </span>
                      <input
                        value={subject}
                        onChange={(e) => setSubject(e.target.value)}
                        maxLength={500}
                        placeholder="e.g. VPN not connecting"
                        className="mt-1.5 h-11 w-full rounded-lg border border-line-dark bg-card px-3.5 text-[14px] outline-none transition focus:border-teal-500 focus:ring-3 focus:ring-teal-500/15"
                      />
                    </label>
                    <label className="block">
                      <span className="flex items-baseline justify-between text-[13px] font-medium text-ink-2">
                        Describe the problem
                        <span className={`text-[11.5px] font-normal tabular ${nearLimit ? 'text-rose-600' : 'text-ink-3'}`}>
                          {body.length.toLocaleString()} / {MAX_BODY.toLocaleString()}
                        </span>
                      </span>
                      <textarea
                        id="help-body"
                        value={body}
                        onChange={(e) => setBody(e.target.value)}
                        required
                        maxLength={MAX_BODY}
                        rows={6}
                        placeholder={activeTopic?.hint ?? 'What happened, and since when?'}
                        className="mt-1.5 w-full resize-y rounded-lg border border-line-dark bg-card px-3.5 py-3 text-[14px] leading-relaxed outline-none transition focus:border-teal-500 focus:ring-3 focus:ring-teal-500/15"
                      />
                    </label>
                    {error && (
                      <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-[13px] text-rose-800">
                        {error}
                      </p>
                    )}
                    <div className="flex flex-col-reverse gap-3 border-t border-line pt-5 sm:flex-row sm:items-center">
                      <span
                        className="flex items-center gap-1.5 text-[12px] text-ink-3"
                        title="Emails, phone numbers and account numbers are masked before any AI reads your ticket."
                      >
                        <Lock size={13} className="text-teal-600" aria-hidden />
                        Personal data is masked automatically.
                      </span>
                      <button
                        type="submit"
                        disabled={!body.trim() || sending}
                        className="flex h-11 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-brand-950 to-brand-800 px-6 text-[14px] font-semibold text-white shadow-[0_10px_24px_-12px_rgb(8_26_40/0.8)] transition hover:to-brand-700 focus-visible:ring-2 focus-visible:ring-teal-400 focus-visible:outline-none disabled:opacity-50 disabled:shadow-none sm:ml-auto"
                      >
                        {sending ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Send size={16} aria-hidden />}
                        {sending ? 'Sending' : 'Submit ticket'}
                      </button>
                    </div>
                  </form>
                )}
              </section>
              {done && <RelatedReading ticketId={done.ticket_id} className="lg:sticky lg:top-6" />}
            </div>

            {/* What happens next */}
            <section aria-labelledby="next-title">
              <h2 id="next-title" className="mb-3 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">
                What happens next
              </h2>
              <ol className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {STEPS.map((s, i) => {
                  const Icon = s.icon;
                  return (
                    <li key={s.title} className="help-step rounded-xl border border-line bg-card p-4 shadow-sentinel-sm">
                      <div className="flex items-center justify-between">
                        <span className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-teal-50 to-sky-50 text-teal-700 ring-1 ring-teal-100">
                          <Icon size={17} aria-hidden />
                        </span>
                        <span className="font-mono text-[11px] font-semibold text-ink-3">0{i + 1}</span>
                      </div>
                      <p className="mt-3 text-[13.5px] font-semibold text-ink">{s.title}</p>
                      <p className="mt-0.5 text-[12.5px] leading-snug text-ink-3">{s.body}</p>
                    </li>
                  );
                })}
              </ol>
            </section>

            {/* Your tickets */}
            <section aria-labelledby="mine-title">
              <div className="mb-3 flex items-center gap-2">
                <h2 id="mine-title" className="flex items-center gap-2 text-[15px] font-semibold text-ink">
                  <Clock3 size={16} className="text-ink-3" aria-hidden /> Your tickets
                </h2>
                {mine.length > 0 && (
                  <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[11.5px] font-semibold text-brand-700">{openCount} open</span>
                )}
                {mine.length > 0 && (
                  <div className="ml-auto flex items-center gap-1">
                    {mine.some((t) => t.status === 'missing') && (
                      <button
                        type="button"
                        onClick={removeMissing}
                        title={STATUS.missing.tip}
                        className="rounded-lg px-2.5 py-1 text-[12.5px] font-medium text-ink-3 transition hover:bg-card hover:text-ink focus-visible:ring-2 focus-visible:ring-teal-400 focus-visible:outline-none"
                      >
                        Remove expired
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={manualRefresh}
                      title="Refresh status"
                      className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12.5px] font-medium text-ink-3 transition hover:bg-card hover:text-ink focus-visible:ring-2 focus-visible:ring-teal-400 focus-visible:outline-none"
                    >
                      <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} aria-hidden /> Refresh
                    </button>
                  </div>
                )}
              </div>
              {mine.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line-dark bg-card/70 px-5 py-10 text-center">
                  <span className="grid h-11 w-11 place-items-center rounded-full bg-page text-ink-3">
                    <Inbox size={20} aria-hidden />
                  </span>
                  <p className="text-[14px] font-medium text-ink-2">No tickets yet</p>
                  <p className="max-w-xs text-[13px] text-ink-3">Tickets you submit from this browser show up here, with live status.</p>
                </div>
              ) : (
                <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card shadow-sentinel-sm">
                  {mine.map((t) => (
                    <TicketRow key={t.ticket_id} t={t} />
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>

      <footer className="pb-8 text-center text-[12px] text-ink-3">SentinelDesk · AI incident triage for IT support teams</footer>
    </div>
  );
}
