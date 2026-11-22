import { BarChart3, Funnel, History, KanbanSquare, ListChecks, Radar } from 'lucide-react';
import { useTickets } from '../state/tickets.jsx';
import { HEALTH, USE_MOCK, healthTitle, useHealth } from '../lib/useHealth.js';
import { VIEWS, countView, viewHref } from '../lib/views.js';

// Dark rail that continues the top bar. Icons only below lg; labels, queue counts and engine status from lg up.
const itemBase =
  'relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-teal-300 max-lg:justify-center';
const itemTone = (active) => (active ? 'bg-brand-700 text-white' : 'text-slate-300 hover:bg-white/5 hover:text-white');
const ActiveMark = () => <span className="absolute top-2 bottom-2 -left-2 w-[3px] rounded-r bg-teal-300" aria-hidden />;

function Group({ children }) {
  return <div className="hidden px-2.5 pt-4 pb-1.5 text-[11.5px] font-medium text-slate-400 lg:block">{children}</div>;
}

function Count({ n, hot }) {
  if (n == null) return null;
  return (
    <span
      className={`tabular ml-auto hidden text-[11.5px] lg:inline ${hot && n > 0 ? 'rounded-full bg-red-600 px-1.5 font-semibold text-white' : 'text-slate-400'}`}
    >
      {n}
    </span>
  );
}

export default function SideRail({ route, onHistory }) {
  const { tickets } = useTickets();
  const health = useHealth();
  const hs = HEALTH[health.state];
  const view = route.view ?? 'needs';
  const onDashboard = route.page === 'dashboard';
  const needs = countView(tickets, 'needs');
  const openCount = tickets.filter((t) => t.status !== 'resolved').length;

  const top = [
    { key: 'overview', href: '#/console', icon: ListChecks, label: 'Overview', active: (onDashboard && view === 'needs') || route.page === 'ticket', n: needs, hot: true },
    { key: 'board', href: '#/board', icon: KanbanSquare, label: 'Board', active: route.page === 'board', n: openCount },
    {
      key: 'lab',
      href: '#/lab',
      icon: Radar,
      label: 'Live triage',
      tip: 'Test sandbox: paste any ticket and see the full triage. Test tickets never trip a real outage.',
      active: route.page === 'lab',
    },
  ];

  return (
    <nav
      aria-label="Main"
      className="flex w-14 shrink-0 flex-col border-t border-white/10 bg-brand-950 px-2 py-3 lg:w-[216px]"
    >
      <div className="hidden px-2.5 pb-1.5 text-[11.5px] font-medium text-slate-400 lg:block">Work</div>
      {top.map(({ key, href, icon: Icon, label, tip, active, n, hot }) => (
        <a key={key} href={href} title={tip ?? label} aria-current={active ? 'page' : undefined} className={`${itemBase} ${itemTone(active)}`}>
          {active && <ActiveMark />}
          <Icon size={17} className="shrink-0" aria-hidden />
          <span className="hidden lg:inline">{label}</span>
          {hot && n > 0 && <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-red-500 lg:hidden" aria-hidden />}
          <Count n={n} hot={hot} />
        </a>
      ))}

      <Group>Queues</Group>
      <div className="hidden flex-col lg:flex">
        {VIEWS.filter((v) => v.rail).map((v) => {
          const active = onDashboard && view === v.id;
          return (
            <a
              key={v.id}
              href={viewHref(v.id)}
              aria-current={active ? 'page' : undefined}
              className={`${itemBase} py-1.5 pl-[38px] text-[12.5px] ${active ? 'bg-brand-700 text-white' : 'text-slate-300/90 hover:bg-white/5 hover:text-white'}`}
            >
              {active && <ActiveMark />}
              <span className={`absolute left-[17px] h-2 w-2 rounded-full ${v.dot}`} aria-hidden />
              {v.label}
              <Count n={countView(tickets, v.id)} />
            </a>
          );
        })}
      </div>

      <Group>Analyse</Group>
      <a
        href="#/funnel"
        title="Waterfall funnel of live tickets with pivots"
        aria-current={route.page === 'funnel' ? 'page' : undefined}
        className={`${itemBase} ${itemTone(route.page === 'funnel')} max-lg:mt-1`}
      >
        {route.page === 'funnel' && <ActiveMark />}
        <Funnel size={17} className="shrink-0" aria-hidden />
        <span className="hidden lg:inline">Funnel</span>
      </a>
      <a href="#/insights" title="Reports" aria-current={route.page === 'insights' ? 'page' : undefined} className={`${itemBase} ${itemTone(route.page === 'insights')}`}>
        {route.page === 'insights' && <ActiveMark />}
        <BarChart3 size={17} className="shrink-0" aria-hidden />
        <span className="hidden lg:inline">Reports</span>
      </a>
      <button type="button" onClick={onHistory} title="History" className={`${itemBase} ${itemTone(false)}`}>
        <History size={17} className="shrink-0" aria-hidden />
        <span className="hidden lg:inline">History</span>
      </button>

      <div title={healthTitle(health)} className="mt-auto border-white/10 pt-3 lg:border-t lg:px-2.5">
        <div className={`flex items-center gap-2 text-[12px] font-semibold ${hs.text} max-lg:justify-center`}>
          <span className={`h-2 w-2 shrink-0 rounded-full ${hs.dot}`} aria-hidden />
          <span className="hidden lg:inline">{hs.label}</span>
        </div>
        <p className="mt-0.5 hidden text-[11.5px] text-slate-400 lg:block">
          {USE_MOCK || health.detail?.mode === 'mock' ? 'Mock engine' : 'Live engine'}
          {health.detail?.contract_version && `, contract ${health.detail.contract_version}`}
        </p>
      </div>
    </nav>
  );
}
