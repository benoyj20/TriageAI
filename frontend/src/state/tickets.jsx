import { createContext, useCallback, useContext, useEffect, useMemo, useReducer } from 'react';
import { api, USE_MOCK } from '../api/client.js';
import { describeError } from '../api/normalize.js';
import { buildSeedTickets } from '../data/mockTickets.js';
import { OUTAGE_BURST } from '../data/samples.js';
import { STATUS_FROM_DECISION, WORKFLOW } from '../lib/constants.js';

const Ctx = createContext(null);
const nowIso = () => new Date().toISOString();
const statusLabel = (id) => WORKFLOW.find((w) => w.id === id)?.label ?? id;

// Client-side workflow fields; the engine only returns the gate decision. Existing values win.
const withWorkflow = (t) => ({
  status: STATUS_FROM_DECISION[t.gate.decision],
  review: t.gate.decision === 'AUTO_DRAFT' ? 'auto' : 'pending',
  ...t,
});
export const clustersOf = (tickets) => [...new Set(tickets.map((t) => t.burst?.cluster_id).filter(Boolean))];

function reducer(state, a) {
  const log = (entry) => [{ at: nowIso(), ...entry }, ...state.history].slice(0, 100);
  switch (a.type) {
    case 'SYNC': {
      // Server list wins for the ticket and its status; review/feedback stay local to this console.
      const local = new Map(state.tickets.map((t) => [t.ticket_id, t]));
      const fromServer = a.tickets.map((t) => {
        const prev = local.get(t.ticket_id);
        return withWorkflow(prev ? { ...t, review: prev.review, applied: prev.applied, feedback: prev.feedback } : t);
      });
      const ids = new Set(fromServer.map((t) => t.ticket_id));
      // Mock mode keeps its seeded demo tickets alongside the browser-local store.
      const keep = USE_MOCK ? state.tickets.filter((t) => !ids.has(t.ticket_id)) : [];
      const tickets = [...fromServer, ...keep].sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
      return { ...state, tickets, synced: true, syncError: null };
    }
    case 'SYNC_ERROR':
      return state.syncError === a.message ? state : { ...state, syncError: a.message };
    case 'ADD':
      return {
        ...state,
        tickets: [a.ticket, ...state.tickets.filter((t) => t.ticket_id !== a.ticket.ticket_id)],
        history: log({ id: a.ticket.ticket_id, text: `Triaged → ${a.ticket.gate.decision.replace('_', ' ').toLowerCase()}` }),
      };
    case 'MOVE': {
      const t = state.tickets.find((x) => x.ticket_id === a.id);
      if (!t || t.status === a.status) return state;
      return {
        ...state,
        tickets: state.tickets.map((x) => (x.ticket_id === a.id ? { ...x, status: a.status } : x)),
        history: log({ id: a.id, text: `Moved to ${statusLabel(a.status)}` }),
      };
    }
    case 'REVIEW':
      return {
        ...state,
        tickets: state.tickets.map((x) =>
          x.ticket_id === a.id ? { ...x, review: a.verdict, applied: a.fields ?? x.applied, feedback: a.feedback ?? x.feedback } : x,
        ),
        history: log({
          id: a.id,
          text:
            a.verdict === 'accepted' ? `Accepted suggestions${a.fields ? ` (${a.fields.join(', ')})` : ''}`
            : a.verdict === 'rejected' ? 'Rejected suggestions'
            : 'Reopened suggestions',
        }),
      };
    case 'FEEDBACK':
      return {
        ...state,
        tickets: state.tickets.map((x) => (x.ticket_id === a.id ? { ...x, feedback: a.value } : x)),
        history: log({ id: a.id, text: a.value === 'up' ? 'Rated draft helpful' : 'Rated draft unhelpful' }),
      };
    case 'RESOLVE_OUTAGE': {
      const open = state.tickets.filter((x) => x.burst && x.status !== 'resolved');
      return {
        ...state,
        tickets: state.tickets.map((x) => (x.burst && x.status !== 'resolved' ? { ...x, status: 'resolved' } : x)),
        history: log({ id: clustersOf(open).join(', ') || 'Major incident', text: 'Major incident resolved' }),
      };
    }
    case 'VISIT':
      if (state.history[0]?.id === a.id && state.history[0]?.text === 'Viewed') return state;
      return { ...state, history: log({ id: a.id, text: 'Viewed' }) };
    case 'TOAST':
      return { ...state, toasts: [...state.toasts, a.toast] };
    case 'DISMISS':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== a.id) };
    case 'PENDING':
      return { ...state, pending: [...state.pending, a.item] };
    case 'PENDING_DONE':
      return { ...state, pending: state.pending.filter((p) => p.key !== a.key) };
    case 'BUSY':
      return { ...state, busy: { ...state.busy, [a.key]: a.value } };
    default:
      return state;
  }
}

const init = () => ({ tickets: USE_MOCK ? buildSeedTickets().map(withWorkflow) : [], pending: [], history: [], toasts: [], busy: {} });

export function TicketsProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, init);

  const toast = useCallback((text, tone = 'info') => {
    const id = Math.random().toString(36).slice(2);
    dispatch({ type: 'TOAST', toast: { id, text, tone } });
    setTimeout(() => dispatch({ type: 'DISMISS', id }), 4000);
  }, []);

  const triage = useCallback(async (input, opts) => {
    const key = Math.random().toString(36).slice(2);
    dispatch({ type: 'PENDING', item: { key, subject: input.subject || input.body?.slice(0, 80) || 'Untitled', at: nowIso() } });
    try {
      const ticket = withWorkflow(await api.triage(input, opts));
      dispatch({ type: 'ADD', ticket });
      return ticket;
    } finally {
      dispatch({ type: 'PENDING_DONE', key });
    }
  }, []);

  const simulateOutage = useCallback(async () => {
    dispatch({ type: 'BUSY', key: 'outage', value: true });
    try {
      const results = [];
      // SIM- ticket IDs put these demo tickets in the engine's separate demo burst window,
      // so the demo never counts toward real outage detection.
      const run = Date.now().toString(36).toUpperCase();
      for (const [i, t] of OUTAGE_BURST.entries()) {
        results.push(await triage({ ...t, ticket_id: `SIM-${run}-${i + 1}` }, { burst: true }));
      }
      const joined = results.filter((r) => r.burst);
      if (joined.length) {
        toast(`Burst detected: ${joined.length} ticket${joined.length > 1 ? 's' : ''} joined ${clustersOf(joined).join(', ')}`, 'critical');
      } else {
        toast(`${results.length} tickets triaged; the engine reported no burst cluster`, 'info');
      }
    } catch (e) {
      toast(describeError(e), 'critical');
    } finally {
      dispatch({ type: 'BUSY', key: 'outage', value: false });
    }
  }, [triage, toast]);

  // Status changes are saved to the shared store, so the ticket's creator sees them too.
  const move = useCallback(
    (id, status) => {
      dispatch({ type: 'MOVE', id, status });
      api.setTicketStatus(id, status).catch((e) => toast(`Status not saved: ${describeError(e)}`, 'critical'));
    },
    [toast],
  );

  const resolveOutage = useCallback(() => {
    const open = state.tickets.filter((x) => x.burst && x.status !== 'resolved');
    dispatch({ type: 'RESOLVE_OUTAGE' });
    open.forEach((t) => api.setTicketStatus(t.ticket_id, 'resolved').catch(() => {}));
  }, [state.tickets]);

  const value = useMemo(
    () => ({
      ...state,
      dispatch,
      toast,
      triage,
      simulateOutage,
      resolveOutage,
      move,
      review: (id, verdict, fields) => dispatch({ type: 'REVIEW', id, verdict, fields }),
      byId: (id) => state.tickets.find((t) => t.ticket_id === id),
      outage: state.tickets.filter((t) => t.burst && t.status !== 'resolved'),
    }),
    [state, toast, triage, simulateOutage, resolveOutage, move],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Incident-manager views: pull every creator's tickets from the shared store and keep them fresh. */
export function useServerSync(everyMs = 5000) {
  const { dispatch } = useTickets();
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      if (document.hidden) return;
      try {
        const items = await api.tickets();
        if (alive) dispatch({ type: 'SYNC', tickets: items });
      } catch (err) {
        // Shown as a strip above the console, so an empty list is never mistaken for "no tickets".
        if (alive) dispatch({ type: 'SYNC_ERROR', message: err?.message ?? String(err) });
      }
    };
    pull();
    const id = setInterval(pull, everyMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [dispatch, everyMs]);
}

export function useTickets() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTickets must be used inside <TicketsProvider>');
  return v;
}
