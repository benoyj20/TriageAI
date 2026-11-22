import { lazy, Suspense, useState } from 'react';
import TopBar from './components/TopBar.jsx';
import SideRail from './components/SideRail.jsx';
import OutageBanner from './components/OutageBanner.jsx';
import HistoryDrawer from './components/HistoryDrawer.jsx';
import Toasts from './components/Toasts.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import Landing from './pages/Landing.jsx';
import CreatorPortal from './pages/CreatorPortal.jsx';
import TriageDashboard from './pages/TriageDashboard.jsx';
import KanbanBoard from './pages/KanbanBoard.jsx';
import TicketDetail from './pages/TicketDetail.jsx';
import TriageLab from './pages/TriageLab.jsx';
import { go, useHashRoute } from './lib/useHashRoute.js';
import { useServerSync, useTickets } from './state/tickets.jsx';

// Recharts is heavy; load the Insights tab only when it is opened.
const InsightsPage = lazy(() => import('./pages/InsightsPage.jsx'));
const FunnelPage = lazy(() => import('./pages/FunnelPage.jsx'));

const ROLE_HOME = { creator: '#/help', manager: '#/console' };

const chooseRole = (role) => {
  try {
    localStorage.setItem('sd-role', role);
  } catch {
    /* role memory is a convenience only */
  }
  go(ROLE_HOME[role]);
};

export default function App() {
  const route = useHashRoute();

  if (route.page === 'landing') return <Landing onChoose={chooseRole} />;
  if (route.page === 'help') {
    return (
      <ErrorBoundary resetKey={`help/${route.id ?? ''}`}>
        <CreatorPortal ticketId={route.id} />
      </ErrorBoundary>
    );
  }
  return <ManagerConsole route={route} />;
}

// Shown only when the shared ticket store can't be read, so an empty console is never mistaken for "no tickets".
function SyncNotice() {
  const { syncError, synced } = useTickets();
  if (!syncError) return null;
  return (
    <div role="status" className="bg-amber-50 px-4 py-1.5 text-[12.5px] text-amber-900 border-b border-amber-200">
      <span className="font-semibold">Can't load tickets from the server.</span> {syncError}{' '}
      {synced ? 'Showing the last list we loaded.' : ''} Retrying every 5 s.
    </div>
  );
}

// Incident manager: queues, board, reports and ticket detail. Resolvers don't create tickets here.
function ManagerConsole({ route }) {
  const [query, setQuery] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  useServerSync();

  const page = {
    dashboard: <TriageDashboard view={route.view} query={query} setQuery={setQuery} />,
    board: <KanbanBoard query={query} setQuery={setQuery} />,
    insights: (
      <Suspense fallback={<div className="p-8 text-[13px] text-ink-3">Loading insights…</div>}>
        <InsightsPage />
      </Suspense>
    ),
    funnel: (
      <Suspense fallback={<div className="p-8 text-[13px] text-ink-3">Loading funnel…</div>}>
        <FunnelPage />
      </Suspense>
    ),
    ticket: <TicketDetail id={route.id} />,
    // Test sandbox: paste any ticket and inspect the full triage (tickets are tagged TEST-).
    lab: <TriageLab />,
  }[route.page];

  return (
    <div className="flex h-full flex-col">
      <TopBar route={route} query={query} setQuery={setQuery} />
      <SyncNotice />
      <OutageBanner />
      <div className="flex min-h-0 flex-1">
        <SideRail route={route} onHistory={() => setShowHistory(true)} />
        <main className="thin-scroll min-w-0 flex-1 overflow-y-auto">
          <ErrorBoundary resetKey={`${route.page}/${route.id ?? ''}`}>{page}</ErrorBoundary>
        </main>
      </div>
      {showHistory && <HistoryDrawer onClose={() => setShowHistory(false)} />}
      <Toasts />
    </div>
  );
}
