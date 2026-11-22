import { useCallback, useEffect, useState } from 'react';
import { Check, CheckCircle2, Loader2, SearchX } from 'lucide-react';
import { api } from '../../api/client.js';
import RelatedReading from './RelatedReading.jsx';
import { STATUS, StatusPill, rememberStatus, when } from './status.jsx';

// A ticket creator's view of one of their tickets: their words, where it stands, and readings that may help.
// Deliberately no triage internals (scores, queues, reasons, drafts): those belong to the incident manager.

const MIDDLE = {
  new: 'Waiting in queue',
  review: STATUS.review.label,
  drafted: STATUS.drafted.label,
  escalated: STATUS.escalated.label,
  resolved: 'Handled by support',
};

// A title for tickets sent without a subject: the first words of the message, cut at a word.
const headline = (body = '') => {
  const t = body.trim().split('\n')[0];
  return t.length <= 80 ? t : `${t.slice(0, 80).replace(/\s+\S*$/, '')}…`;
};

function Steps({ view }) {
  const resolved = view.status === 'resolved';
  const steps = [
    { label: 'Received', sub: when(view.created_at), done: true },
    {
      label: MIDDLE[view.status] ?? MIDDLE.new,
      sub: view.status === 'new' ? 'Up next' : '',
      done: view.status !== 'new',
      urgent: view.status === 'escalated',
    },
    {
      label: 'Resolved',
      sub: resolved ? when(view.updated_at) : '',
      done: resolved,
    },
  ];
  return (
    <ol className="mt-6 grid grid-cols-3 gap-2" aria-label="Progress">
      {steps.map((s, i) => (
        <li key={i} className="min-w-0">
          <div className={`h-1.5 rounded-full ${s.done ? (s.urgent ? 'bg-rose-500' : 'bg-teal-500') : 'bg-line'}`} />
          <p className={`mt-2 flex items-center gap-1 text-[12.5px] font-medium ${s.done ? 'text-ink' : 'text-ink-3'}`}>
            {s.done && <Check size={13} className="shrink-0 text-teal-600" aria-hidden />}
            <span className="truncate">{s.label}</span>
          </p>
          {s.sub && <p className="truncate text-[11.5px] text-ink-3">{s.sub}</p>}
        </li>
      ))}
    </ol>
  );
}

export default function CreatorTicket({ id }) {
  const [view, setView] = useState(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    try {
      const v = await api.ticketView(id);
      setView(v);
      rememberStatus(id, { status: v.status, updated_at: v.updated_at });
    } catch (err) {
      if (err?.status === 404) {
        setMissing(true);
        rememberStatus(id, { status: 'missing' });
      }
      // other errors: keep what is on screen and try again on the next tick
    }
  }, [id]);

  useEffect(() => {
    load();
    const t = setInterval(() => !document.hidden && load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  if (missing) {
    return (
      <div className="mx-auto max-w-3xl">
        <section className="help-card rounded-2xl p-8 text-center">
          <SearchX size={28} className="mx-auto text-ink-3" aria-hidden />
          <h1 className="mt-3 text-[18px] font-semibold text-ink">We can't find this ticket</h1>
          <p className="mx-auto mt-1 max-w-sm text-[13.5px] text-ink-3">{STATUS.missing.tip}</p>
          <a
            href="#/help"
            className="mt-5 inline-block rounded-lg bg-brand-950 px-4 py-2 text-[13.5px] font-semibold text-white hover:bg-brand-800"
          >
            Submit a new ticket
          </a>
        </section>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center gap-2 help-card rounded-2xl p-8 text-[13.5px] text-ink-3">
          <Loader2 size={16} className="animate-spin" aria-hidden /> Loading your ticket…
        </div>
      </div>
    );
  }

  const resolved = view.status === 'resolved';
  return (
    // Open ticket: the ticket on the left, readings that may solve it on the right (stacked on phones).
    <div className={resolved ? 'mx-auto max-w-3xl' : 'grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px]'}>
      <section className="help-card rounded-2xl p-6 sm:p-8">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-[12.5px] text-ink-3">{view.ticket_id}</span>
          <span className="ml-auto">
            <StatusPill status={view.status} />
          </span>
        </div>
        <h1 className="mt-2 text-[21px] font-semibold tracking-tight text-ink" lang={view.language}>
          {view.subject || headline(view.body) || 'Your ticket'}
        </h1>
        <p className="mt-0.5 text-[13px] text-ink-3">Submitted {when(view.created_at)}</p>

        {resolved && (
          <div role="status" className="mt-5 flex items-start gap-3 rounded-xl bg-emerald-50 px-4 py-3 text-[13.5px] text-emerald-900">
            <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden />
            <p>
              <span className="font-semibold">Resolved {when(view.updated_at)}.</span> If the problem comes back, submit a new ticket and
              mention this ID.
            </p>
          </div>
        )}

        <Steps view={view} />

        <div className="mt-6 border-t border-line pt-5">
          <p className="text-[12px] font-semibold tracking-wide text-ink-3 uppercase">
            Your message{' '}
            <span
              title="Emails, phone numbers and account numbers are masked before anyone else reads your ticket."
              className="cursor-help font-normal normal-case tracking-normal"
            >
              · personal data masked
            </span>
          </p>
          <p className="mt-2 text-[14px] leading-relaxed whitespace-pre-wrap text-ink-2" lang={view.language}>
            {view.body}
          </p>
        </div>
      </section>

      {!resolved && <RelatedReading ticketId={view.ticket_id} className="lg:sticky lg:top-6" />}
    </div>
  );
}
