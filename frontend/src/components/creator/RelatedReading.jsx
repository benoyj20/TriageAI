import { useCallback, useEffect, useState } from 'react';
import { BookOpen, ChevronDown, Languages, RotateCw } from 'lucide-react';
import { api } from '../../api/client.js';
import { LANGUAGES } from '../../lib/constants.js';

// "Similar issues, already solved": past tickets close to this one, with how support solved them,
// in the language the customer wrote in (translated by the engine when needed). No scores or queues.

// Knowledge-base answers keep privacy placeholders such as <tel_num>; show them as plain words.
const PLACEHOLDER_WORDS = {
  name: 'name',
  tel_num: 'phone number',
  acc_num: 'account number',
  email: 'email address',
  address: 'address',
};

function Readable({ text }) {
  // <tel_num> style and the dataset's other style, [Name].
  const parts = String(text ?? '').split(/(<[^<>\s]{1,40}>|\[name\])/gi);
  return parts.map((p, i) => {
    const m = /^<([^<>\s]+)>$|^\[(name)\]$/i.exec(p);
    if (!m) return p;
    const key = (m[1] ?? m[2]).toLowerCase();
    const word = PLACEHOLDER_WORDS[key] ?? key.replace(/_/g, ' ');
    return (
      <span key={i} title="Hidden for privacy" className="rounded bg-sand px-1 text-[0.92em] text-ink-3">
        {word}
      </span>
    );
  });
}

function LanguageNote({ item, reader }) {
  if (item.translated) {
    const from = LANGUAGES[item.original_language] ?? item.original_language;
    return (
      <span
        title={`Translated by AI from the original ${from} answer.`}
        className="inline-flex shrink-0 cursor-help items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[11.5px] text-brand-700"
      >
        <Languages size={12} aria-hidden /> Translated from {from}
      </span>
    );
  }
  if (item.language !== reader) {
    const lang = LANGUAGES[item.language] ?? item.language;
    return (
      <span
        title="We couldn't translate this one, so it's shown as it was written."
        className="inline-flex shrink-0 cursor-help items-center gap-1 rounded-full bg-sand px-2 py-0.5 text-[11.5px] text-ink-3"
      >
        <Languages size={12} aria-hidden /> In {lang}
      </span>
    );
  }
  return null;
}

export default function RelatedReading({ ticketId, className = '' }) {
  const [state, setState] = useState({
    loading: true,
    error: false,
    data: null,
  });

  const load = useCallback(async () => {
    setState({ loading: true, error: false, data: null });
    try {
      setState({
        loading: false,
        error: false,
        data: await api.relatedTickets(ticketId),
      });
    } catch {
      setState({ loading: false, error: true, data: null });
    }
  }, [ticketId]);

  useEffect(() => {
    load();
  }, [load]);

  const items = state.data?.items ?? [];

  // A side panel next to the ticket (stacks below it on phones). The first answer starts open.
  return (
    <section aria-labelledby={`related-${ticketId}`} className={`help-card rounded-2xl p-5 sm:p-6 ${className}`}>
      <h2 id={`related-${ticketId}`} className="flex items-center gap-2 text-[15px] font-semibold text-ink">
        <BookOpen size={16} className="text-teal-700" aria-hidden /> Similar issues, already solved
      </h2>
      <p className="mt-0.5 mb-3 text-[13px] text-ink-3">These answers fixed problems like yours. One may help while you wait.</p>

      {state.loading && (
        <div className="space-y-2" aria-live="polite">
          <p className="text-[12.5px] text-ink-3">Finding similar solved issues…</p>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[74px] animate-pulse rounded-xl border border-line bg-card" />
          ))}
        </div>
      )}

      {!state.loading && !state.error && items.length === 0 && (
        <div className="rounded-xl border border-dashed border-line-dark bg-card/70 px-5 py-5 text-[13px] text-ink-3">
          Nothing similar on record yet. Our team will reply to your ticket.
        </div>
      )}

      {state.error && (
        <div className="flex items-center gap-3 rounded-xl border border-line bg-card px-5 py-4 text-[13px] text-ink-3">
          Suggestions aren't available right now.
          <button onClick={load} className="ml-auto flex items-center gap-1.5 font-medium text-brand-600 hover:underline">
            <RotateCw size={13} aria-hidden /> Try again
          </button>
        </div>
      )}

      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((it, i) => (
            <li key={it.ref}>
              <details open={i === 0} className="group rounded-xl border border-line bg-card open:shadow-sentinel-md">
                <summary className="flex cursor-pointer list-none items-start gap-3 px-5 py-3.5 outline-none focus-visible:ring-2 focus-visible:ring-teal-400 [&::-webkit-details-marker]:hidden">
                  <div className="min-w-0 flex-1" lang={it.language}>
                    <p className="text-[14px] font-medium text-ink">
                      <Readable text={it.subject || 'Similar issue'} />
                    </p>
                    <div className="mt-1 empty:hidden">
                      <LanguageNote item={it} reader={state.data.language} />
                    </div>
                    <p className="mt-1 line-clamp-2 text-[13px] text-ink-3 group-open:hidden">
                      <Readable text={it.answer} />
                    </p>
                  </div>
                  <ChevronDown size={16} className="mt-0.5 shrink-0 text-ink-3 transition group-open:rotate-180" aria-hidden />
                </summary>
                <div className="space-y-3 border-t border-line px-5 py-4 text-[13.5px] leading-relaxed text-ink-2" lang={it.language}>
                  {it.problem && (
                    <div>
                      <p className="text-[12px] font-semibold tracking-wide text-ink-3 uppercase">The problem</p>
                      <p className="mt-1">
                        <Readable text={it.problem} />
                      </p>
                    </div>
                  )}
                  <div>
                    <p className="text-[12px] font-semibold tracking-wide text-ink-3 uppercase">How it was solved</p>
                    <p className="mt-1">
                      <Readable text={it.answer} />
                    </p>
                  </div>
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
