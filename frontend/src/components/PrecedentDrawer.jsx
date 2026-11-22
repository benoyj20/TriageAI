import { useEffect } from 'react';
import { ChevronLeft, ChevronRight, Copy, Highlighter, X } from 'lucide-react';
import { useDialog } from '../lib/useDialog.js';
import { LANGUAGES, PRIORITIES } from '../lib/constants.js';
import { pct } from '../lib/format.js';

// A similar (precedent) ticket from the knowledge base. These are historical tickets, not tickets in
// this session, so they open here instead of on the ticket page. Contract v1 returns the subject, a
// snippet of the agent's answer, tags and labels; the original customer message is not included.
export default function PrecedentDrawer({ ticket, precedents, index, setIndex, onClose, onHighlight, toast }) {
  const ref = useDialog(onClose);
  const p = precedents[index];
  const cite = ticket.draft.citations.indexOf(p.ticket_id);
  const cited = cite !== -1;
  const isTop = index === 0;

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('input, textarea, select')) return;
      if (e.key === 'ArrowLeft' && index > 0) setIndex(index - 1);
      if (e.key === 'ArrowRight' && index < precedents.length - 1) setIndex(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, precedents.length, setIndex]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(p.answer_snippet);
      toast('Resolution copied to clipboard', 'good');
    } catch {
      toast('Clipboard is blocked in this browser', 'critical');
    }
  };

  const tags = [p.type, p.queue, PRIORITIES[p.priority]?.label, p.language?.toUpperCase(), ...(p.tags ?? [])].filter(Boolean);

  return (
    <div className="fixed inset-0 z-50 bg-brand-950/30" onMouseDown={onClose}>
      <aside
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="precedent-title"
        onMouseDown={(e) => e.stopPropagation()}
        className="animate-slide-in absolute top-0 right-0 flex h-full w-full max-w-[480px] flex-col border-l border-line bg-card shadow-2xl"
      >
        <header className="border-b border-line px-5 pt-4 pb-4">
          <div className="flex items-center gap-2 text-[12px] text-ink-3">
            <span className="font-mono font-medium text-brand-600">{p.ticket_id}</span>
            <span>Similar ticket {index + 1} of {precedents.length}</span>
            <button onClick={onClose} className="ml-auto rounded p-1 text-ink-3 hover:bg-sand-2 hover:text-ink" aria-label="Close similar ticket">
              <X size={17} />
            </button>
          </div>
          <h2 id="precedent-title" className="mt-2 text-[17px] leading-snug font-semibold text-ink">{p.subject}</h2>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <span key={tag} className="rounded bg-sand-2 px-2 py-0.5 text-[11.5px] text-ink-2">{tag}</span>
            ))}
          </div>
        </header>

        <div className="thin-scroll flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <section>
            <h3 className="mb-2 text-[12.5px] font-semibold text-ink-2">Why it matched</h3>
            <div className="flex items-center gap-3 rounded-lg border border-teal-200 bg-teal-50/60 px-3 py-2.5">
              <span className="tabular text-[24px] leading-none font-bold text-teal-700">{pct(p.similarity)}</span>
              <p className="text-[12px] leading-snug text-ink-2">
                {isTop ? 'Closest match' : 'Match'} for {ticket.ticket_id} in {p.queue}.{' '}
                {cited ? <>The reply draft cites it as <b className="text-ink">[c{cite}]</b>.</> : 'The reply draft does not cite it.'}
              </p>
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-[12.5px] font-semibold text-ink-2">How it was resolved</h3>
            {p.answer_snippet ? (
              <blockquote className="border-l-[3px] border-teal-500 py-0.5 pl-3 text-[13.5px] leading-relaxed text-ink">{p.answer_snippet}</blockquote>
            ) : (
              <p className="text-[12.5px] text-ink-3">The knowledge base has no answer text for this ticket.</p>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-[12.5px] font-semibold text-ink-2">Details</h3>
            <dl className="grid grid-cols-[110px_1fr] gap-y-1.5 text-[12.5px]">
              <dt className="text-ink-3">Type</dt><dd>{p.type ?? '—'}</dd>
              <dt className="text-ink-3">Queue</dt><dd>{p.queue ?? '—'}</dd>
              <dt className="text-ink-3">Priority</dt><dd>{PRIORITIES[p.priority]?.label ?? p.priority ?? '—'}</dd>
              <dt className="text-ink-3">Language</dt><dd>{LANGUAGES[p.language] ?? p.language ?? '—'}</dd>
            </dl>
          </section>
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
          <button
            onClick={copy}
            disabled={!p.answer_snippet}
            className="flex items-center gap-1.5 rounded-md bg-brand-700 px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-brand-800 disabled:opacity-40"
          >
            <Copy size={13} /> Copy resolution
          </button>
          <button
            onClick={() => onHighlight(p.ticket_id)}
            disabled={!cited}
            title={cited ? 'Show where the reply draft cites this ticket' : 'The reply draft does not cite this ticket'}
            className="flex items-center gap-1.5 rounded-md border border-line-dark px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-sand disabled:opacity-40"
          >
            <Highlighter size={13} /> Show in draft
          </button>
          <span className="ml-auto flex items-center gap-1">
            <button disabled={index === 0} onClick={() => setIndex(index - 1)} className="grid h-8 w-8 place-items-center rounded-md hover:bg-sand-2 disabled:opacity-30" aria-label="Previous similar ticket">
              <ChevronLeft size={16} />
            </button>
            <button disabled={index === precedents.length - 1} onClick={() => setIndex(index + 1)} className="grid h-8 w-8 place-items-center rounded-md hover:bg-sand-2 disabled:opacity-30" aria-label="Next similar ticket">
              <ChevronRight size={16} />
            </button>
          </span>
        </footer>
      </aside>
    </div>
  );
}
