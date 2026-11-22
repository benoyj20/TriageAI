import { useEffect } from 'react';
import { ArrowLeftRight, Search, ShieldCheck, X } from 'lucide-react';
import { go, ticketHref } from '../lib/useHashRoute.js';
import { useTickets } from '../state/tickets.jsx';

// Incident manager top bar: search and the role switch. Managers resolve tickets, so there is no "New ticket" here.
export default function TopBar({ route, query, setQuery }) {
  const { byId } = useTickets();

  // "/" focuses search from anywhere outside a text field.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el?.tagName) || el?.isContentEditable) return;
      e.preventDefault();
      document.getElementById('global-search-input')?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onSubmit = (e) => {
    e.preventDefault();
    const id = query.trim().toUpperCase();
    if (byId(id)) {
      setQuery('');
      go(ticketHref(id));
    } else if (route.page !== 'dashboard' && route.page !== 'board') {
      go('#/console');
    }
  };

  return (
    <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-3 bg-brand-950 px-3 text-white sm:gap-4 sm:px-4">
      <a href="#/console" className="flex shrink-0 items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-teal-300 lg:w-[192px]">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-teal-500 text-brand-950">
          <ShieldCheck size={19} strokeWidth={2.4} aria-hidden />
        </span>
        <span className="hidden text-[16px] font-bold tracking-tight sm:inline">SentinelDesk</span>
      </a>

      <form onSubmit={onSubmit} role="search" className="relative min-w-0 flex-1 sm:max-w-[440px]">
        <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" aria-hidden />
        <input
          id="global-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tickets or jump to an ID"
          aria-label="Search tickets or jump to an ID"
          className="h-9 w-full rounded-lg border border-white/15 bg-white/[0.07] pr-9 pl-9 text-[13px] text-white placeholder:text-slate-400 outline-none transition focus:border-teal-300/70 focus:bg-white/10 focus:ring-2 focus:ring-teal-300/25"
        />
        {query ? (
          <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-slate-300 hover:text-white">
            <X size={14} />
          </button>
        ) : (
          <kbd className="pointer-events-none absolute top-1/2 right-2.5 hidden -translate-y-1/2 rounded border border-white/20 px-1.5 text-[10.5px] text-slate-400 sm:block">/</kbd>
        )}
      </form>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <a
          href="#/"
          title="Switch role"
          className="flex h-9 items-center gap-1.5 rounded-lg border border-white/15 px-3 text-[13px] font-medium text-slate-200 transition hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-teal-300 focus-visible:outline-none"
        >
          <ArrowLeftRight size={14} aria-hidden />
          <span className="hidden sm:inline">Switch role</span>
        </a>
        <span title="Signed in as incident manager" className="grid h-8 w-8 place-items-center rounded-full bg-brand-700 text-[11px] font-semibold text-white">
          IM
        </span>
      </div>
    </header>
  );
}
