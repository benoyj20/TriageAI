import { History, X } from 'lucide-react';
import { useTickets } from '../state/tickets.jsx';
import { ticketHref } from '../lib/useHashRoute.js';
import { timeAgo } from '../lib/format.js';
import { useDialog } from '../lib/useDialog.js';

// FS-14 — session activity: what was triaged, viewed, moved, accepted.
export default function HistoryDrawer({ onClose }) {
  const { history, byId } = useTickets();
  const ref = useDialog(onClose);
  return (
    <div className="fixed inset-0 z-40" onMouseDown={onClose}>
      <aside
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="History"
        className="animate-slide-in absolute top-0 right-0 flex h-full w-[340px] flex-col border-l border-line bg-card shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="flex items-center gap-2 text-[14px] font-semibold"><History size={16} /> History</h2>
          <button onClick={onClose} className="rounded p-1 text-ink-3 hover:bg-sand-2" aria-label="Close history"><X size={16} /></button>
        </header>
        <ol className="thin-scroll flex-1 overflow-y-auto">
          {history.length === 0 && <li className="px-4 py-6 text-center text-[12.5px] text-ink-3">Nothing yet. Triage or open a ticket.</li>}
          {history.map((h, i) => (
            <li key={i} className="border-b border-line/70 px-4 py-2.5">
              <div className="flex items-baseline justify-between gap-2">
                {!byId(h.id) ? (
                  <span className="text-[12.5px] font-medium">{h.id}</span>
                ) : (
                  <a href={ticketHref(h.id)} onClick={onClose} className="text-[12.5px] font-medium text-brand-600 hover:underline">{h.id}</a>
                )}
                <span className="shrink-0 text-[11px] text-ink-3">{timeAgo(h.at)}</span>
              </div>
              <div className="text-[12px] text-ink-2">{h.text}</div>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
