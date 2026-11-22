// FS-06 — the only module that talks to the network.
// Every call has a timeout and throws ApiError with a message an operator can read.
import { mockApi } from './mockEngine.js';
import { ApiError, normalizeTriage, serverMessage } from './normalize.js';

export { ApiError };

const BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
// Production builds always go through the gateway; its MOCK_ENGINE switch (FS-03) covers demo mode there.
const MOCK_FLAG = import.meta.env.VITE_USE_MOCK;
export const USE_MOCK = import.meta.env.DEV ? MOCK_FLAG !== 'false' : MOCK_FLAG === 'true';

const STATUS_TEXT = {
  400: 'The gateway could not read the ticket. Check the subject and body.',
  413: 'The ticket is too large for the gateway.',
  422: 'The ticket failed validation. The body is required.',
  429: 'Too many requests. Wait a moment and try again.',
  500: 'The gateway hit an internal error. Try again, or check the gateway logs.',
  502: 'The gateway could not reach the triage engine.',
  503: 'The triage engine is unavailable right now.',
  504: 'The triage engine took too long to answer.',
};

const unreachable = (cause) =>
  new ApiError('Cannot reach the gateway. Is it running on port 8080?', { code: 'NETWORK', cause });

async function request(path, { method = 'GET', body, timeout = 10_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      /* non-JSON body: fall through to status text */
    }
    if (!res.ok) {
      // A dev proxy (or load balancer) answers 502/504 with no JSON body when the gateway itself is down.
      if ((res.status === 502 || res.status === 504) && data === null) throw unreachable();
      throw new ApiError(serverMessage(data) || STATUS_TEXT[res.status] || `Request failed (${res.status}).`, {
        status: res.status,
        code: data?.error?.code || `HTTP_${res.status}`,
        requestId: data?.error?.request_id ?? res.headers.get('X-Request-ID'),
      });
    }
    if (data === null) {
      throw new ApiError('The gateway sent a response that is not JSON.', { status: res.status, code: 'BAD_RESPONSE', requestId: res.headers.get('X-Request-ID') });
    }
    return data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (ctrl.signal.aborted) {
      throw new ApiError(`No answer from the gateway after ${Math.round(timeout / 1000)} s.`, { code: 'TIMEOUT', cause: err });
    }
    throw unreachable(err);
  } finally {
    clearTimeout(timer);
  }
}

async function wrapMock(fn) {
  try {
    return await fn();
  } catch (err) {
    throw err instanceof ApiError ? err : new ApiError(err.message, { code: err.code || 'MOCK' });
  }
}

// Mock mode has no server ticket store: keep one in this browser so both roles still work locally.
const MOCK_STORE = 'sd-mock-ticket-store';
const STATUS_FROM = { ESCALATE_ONCALL: 'escalated', HUMAN_REVIEW: 'review', AUTO_DRAFT: 'drafted' };
const mockStore = {
  read() {
    try {
      return JSON.parse(localStorage.getItem(MOCK_STORE) || '[]');
    } catch {
      return [];
    }
  },
  write(items) {
    try {
      localStorage.setItem(MOCK_STORE, JSON.stringify(items.slice(0, 200)));
    } catch {
      /* storage full or blocked: the list just won't persist */
    }
  },
  add(t) {
    this.write([{ ...t, status: STATUS_FROM[t.gate?.decision] ?? 'new' }, ...this.read().filter((x) => x.ticket_id !== t.ticket_id)]);
  },
};
const statusView = (t) => ({ ticket_id: t.ticket_id, subject: t.subject, created_at: t.created_at, status: t.status, updated_at: t.updated_at ?? t.created_at });
const notFound = () => new ApiError('No ticket with that id.', { status: 404, code: 'NOT_FOUND' });

// Paths and shapes: contracts/README.md (v1).
export const api = {
  health: () => (USE_MOCK ? wrapMock(() => mockApi.health()) : request('/api/v1/health', { timeout: 3_000 })),

  /** @param {{subject?: string, body: string, ticket_id?: string}} ticket */
  triage: async (ticket, opts = {}) => {
    if (USE_MOCK) {
      const t = normalizeTriage(await wrapMock(() => mockApi.triage(ticket, opts)), ticket);
      mockStore.add(t);
      return t;
    }
    return normalizeTriage(await request('/api/v1/triage', { method: 'POST', body: ticket, timeout: 20_000 }), ticket);
  },

  /** Incident managers: recent tickets from every creator, newest first. */
  tickets: async (limit = 200) => {
    const items = USE_MOCK ? mockStore.read() : (await request(`/api/v1/tickets?limit=${limit}`, { timeout: 10_000 })).items;
    // One malformed record must not blank the whole console: skip it and say so in the console.
    return (items ?? []).flatMap((t) => {
      try {
        return [normalizeTriage(t)];
      } catch (err) {
        console.warn(`Skipping stored ticket ${t?.ticket_id ?? '(no id)'}: ${err.message}`);
        return [];
      }
    });
  },

  /** Ticket creators: the minimal status of one of their own tickets. */
  ticketStatus: async (id) => {
    if (USE_MOCK) {
      const t = mockStore.read().find((x) => x.ticket_id === id);
      if (!t) throw notFound();
      return statusView(t);
    }
    return request(`/api/v1/tickets/${encodeURIComponent(id)}/status`, { timeout: 8_000 });
  },

  /** Ticket creators: their own words, language, status and dates. No scores, reasons or drafts. */
  ticketView: async (id) => {
    if (USE_MOCK) {
      const t = mockStore.read().find((x) => x.ticket_id === id);
      if (!t) throw notFound();
      return { ...statusView(t), updated_at: t.updated_at ?? t.created_at, body: t.body, language: t.draft?.language ?? 'en' };
    }
    return request(`/api/v1/tickets/${encodeURIComponent(id)}`, { timeout: 8_000 });
  },

  /** Ticket creators: similar solved tickets in their own language (may wait for one LLM translation). */
  relatedTickets: async (id) => {
    if (USE_MOCK) {
      const t = mockStore.read().find((x) => x.ticket_id === id);
      if (!t) throw notFound();
      const lang = t.draft?.language ?? 'en';
      const items = (t.precedents ?? []).slice(0, 3).map((p) => ({
        ref: p.ticket_id,
        subject: p.subject,
        problem: '',
        answer: p.answer_snippet,
        language: p.language,
        original_language: p.language,
        translated: false,
      }));
      return { ticket_id: id, language: lang, items };
    }
    return request(`/api/v1/tickets/${encodeURIComponent(id)}/related`, { timeout: 25_000 });
  },

  /** Incident managers: move a ticket through the workflow (new, escalated, review, drafted, resolved). */
  setTicketStatus: async (id, status) => {
    if (USE_MOCK) {
      const items = mockStore.read();
      const t = items.find((x) => x.ticket_id === id);
      if (!t) throw notFound();
      t.status = status;
      t.updated_at = new Date().toISOString();
      mockStore.write(items);
      return statusView(t);
    }
    return request(`/api/v1/tickets/${encodeURIComponent(id)}/status`, { method: 'PUT', body: { status }, timeout: 8_000 });
  },
};
