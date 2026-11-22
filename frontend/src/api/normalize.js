// Response handling with no Vite or browser dependencies, so it runs under `node --test`.
// Shapes follow contract v1 (contracts/README.md).
import { DECISIONS, REASONS } from '../lib/constants.js';

export class ApiError extends Error {
  constructor(message, { status = null, code = 'ERROR', requestId = null, cause } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.cause = cause;
  }
}

// Contract envelope {"error": {code, message, request_id}}; FastAPI's {detail} as a fallback.
export function serverMessage(data) {
  const m = data?.error?.message || data?.message || data?.detail;
  if (Array.isArray(m)) return m.map((d) => d?.msg ?? String(d)).join('; ');
  return typeof m === 'string' ? m : null;
}

// Operator-facing error text, with the request ID so a failure can be found in the gateway logs.
export const describeError = (e) => (e?.requestId ? `${e.message} (request ${e.requestId})` : e?.message ?? String(e));

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v, d = '') => (typeof v === 'string' ? v : d);
const probs = (v) => Object.fromEntries(Object.entries(obj(v)).filter(([, p]) => typeof p === 'number'));
const head = (v) => {
  const h = typeof v === 'string' ? { label: v } : obj(v);
  return { ...h, label: String(h.label ?? 'unknown'), confidence: num(h.confidence), probs: probs(h.probs) };
};
const DRAFT_MODES = ['generated', 'extractive', 'holding'];

// Require the few fields the UI cannot work without and default the rest, so a field the engine
// drops shows a readable error instead of crashing a view.
export function normalizeTriage(r, input = {}) {
  const missing = (what) => new ApiError(`The gateway response is missing ${what}.`, { code: 'BAD_RESPONSE', requestId: r?.request_id ?? null });
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw missing('a body');
  if (!['string', 'number'].includes(typeof r.ticket_id) || r.ticket_id === '') throw missing('ticket_id');
  const gate = obj(r.gate);
  if (!DECISIONS[gate.decision]) throw missing('a known gate.decision');
  const cls = obj(r.classification);
  if (!cls.type || !cls.queue || !cls.priority) throw missing('classification.type / queue / priority');

  const now = new Date().toISOString();
  const lang = obj(r.language);
  const code = str(lang.code, 'unknown');
  const language = { code, confidence: num(lang.confidence), supported: typeof lang.supported === 'boolean' ? lang.supported : ['en', 'de'].includes(code) };
  const draft = obj(r.draft);
  const validation = obj(draft.validation);
  const route = obj(obj(r.retrieval).route);
  const priority = head(cls.priority);
  const precedents = arr(r.precedents)
    .filter((p) => p && p.ticket_id)
    .map((p) => ({ ...p, similarity: num(p.similarity), answer_snippet: str(p.answer_snippet), tags: arr(p.tags).map(String) }));
  return {
    ...r,
    request_id: str(r.request_id, null),
    ticket_id: String(r.ticket_id),
    subject: str(r.subject, input.subject ?? ''),
    body: str(r.body, input.body ?? ''),
    created_at: r.created_at || now,
    processed_at: r.processed_at || now,
    language,
    classification: {
      type: head(cls.type),
      queue: { ...head(cls.queue), votes: num(obj(cls.queue).votes), k: num(obj(cls.queue).k) },
      priority: { ...priority, label: priority.label.toLowerCase(), p_high: num(obj(cls.priority).p_high) },
    },
    retrieval: {
      route: {
        queues: arr(route.queues).filter((q) => q && q.queue).map((q) => ({ queue: String(q.queue), score: num(q.score, null) })),
        searched: arr(route.searched).map(String),
        fallback_global: route.fallback_global === true,
      },
      top_similarity: num(obj(r.retrieval).top_similarity, precedents[0]?.similarity ?? 0),
      k: num(obj(r.retrieval).k, 5),
    },
    precedents,
    gate: {
      decision: gate.decision,
      reasons: arr(gate.reasons)
        .filter((x) => x && x.code)
        .map((x) => ({ ...x, severity: x.severity ?? REASONS[x.code]?.severity ?? 'P2', detail: String(x.detail ?? '') })),
    },
    draft: {
      language: draft.language ?? (language.supported ? code : 'en'),
      text: str(draft.text),
      citations: arr(draft.citations),
      mode: DRAFT_MODES.includes(draft.mode) ? draft.mode : 'generated',
      validation: {
        passed: validation.passed === true && Boolean(draft.text),
        citations_ok: validation.citations_ok === true,
        numbers_ok: validation.numbers_ok === true,
        language_ok: validation.language_ok !== false,
        retries: num(validation.retries),
        issues: Array.isArray(validation.issues) ? validation.issues.map(String) : draft.text ? [] : ['No draft was returned.'],
      },
    },
    burst: obj(r.burst).cluster_id ? r.burst : null,
    latency_ms: obj(r.latency_ms),
    pii: { masked: arr(obj(r.pii).masked) },
    warnings: arr(r.warnings).filter((w) => w && w.message).map((w) => ({ stage: str(w.stage), code: str(w.code), message: String(w.message) })),
  };
}
