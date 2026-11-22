// Ticket-creator vocabulary: what a customer may know about a ticket's progress, in plain words.
// `fill` drives the progress track; `bar` is the row's accent colour.

export const MINE = 'sd-my-tickets';

export const STATUS = {
  new: {
    label: 'Received',
    tone: 'bg-sand text-ink-2 ring-line-dark',
    dot: 'bg-slate-400',
    bar: '#94a3b8',
    fill: 0.18,
    tip: 'We have your ticket and it is in the queue.',
  },
  review: {
    label: 'In progress',
    tone: 'bg-sky-50 text-sky-800 ring-sky-200',
    dot: 'bg-sky-500',
    bar: '#0ea5e9',
    fill: 0.5,
    tip: 'A support specialist is looking into it.',
  },
  drafted: {
    label: 'Reply on its way',
    tone: 'bg-teal-50 text-teal-800 ring-teal-200',
    dot: 'bg-teal-500',
    bar: '#14b8a6',
    fill: 0.8,
    tip: 'An answer is being finalised for you.',
  },
  escalated: {
    label: 'Urgent: team engaged',
    tone: 'bg-rose-50 text-rose-800 ring-rose-200',
    dot: 'bg-rose-500',
    bar: '#f43f5e',
    fill: 0.5,
    tip: 'Flagged as urgent. Our on-call team is working on it now.',
  },
  resolved: {
    label: 'Resolved',
    tone: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    dot: 'bg-emerald-500',
    bar: '#10b981',
    fill: 1,
    tip: 'This ticket has been resolved.',
  },
  missing: {
    label: 'Not on record',
    tone: 'bg-sand text-ink-3 ring-line-dark',
    dot: 'bg-slate-300',
    bar: '#cbd5e1',
    fill: 0,
    tip: 'We no longer have this ticket: it expired after 7 days or was sent before tracking began. Please submit it again if you still need help.',
  },
};

export function StatusPill({ status }) {
  const s = STATUS[status] ?? STATUS.new;
  return (
    <span
      title={s.tip}
      className={`inline-flex shrink-0 cursor-help items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium ring-1 ring-inset ${s.tone}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot} ${status === 'escalated' ? 'animate-pulse' : ''}`} aria-hidden />
      {s.label}
    </span>
  );
}

export const readMine = () => {
  try {
    return JSON.parse(localStorage.getItem(MINE) || '[]');
  } catch {
    return [];
  }
};

export const writeMine = (items) => {
  try {
    localStorage.setItem(MINE, JSON.stringify(items.slice(0, 50)));
  } catch {
    /* private mode: history just won't persist */
  }
};

/** Merge a fresh status into the creator's local history (keeps the list in step with the detail view). */
export const rememberStatus = (id, patch) => {
  const items = readMine();
  if (items.some((t) => t.ticket_id === id)) writeMine(items.map((t) => (t.ticket_id === id ? { ...t, ...patch } : t)));
};

export const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
};
