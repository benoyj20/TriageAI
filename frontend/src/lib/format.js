export const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

export const ms = (x) => (x == null ? '—' : x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);

export function shortDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
}

export function dateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** Overall confidence shown in the UI: the weakest of the three calibrated heads. */
export const overallConfidence = (t) =>
  Math.min(t.classification.type.confidence, t.classification.queue.confidence, t.classification.priority.confidence);

export const initials = (name = '') =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');

// Subject is optional in contract v1; fall back to the start of the body.
export function ticketTitle(t) {
  if (t.subject?.trim()) return t.subject;
  const body = (t.body ?? '').replace(/\s+/g, ' ').trim();
  return body ? (body.length > 80 ? `${body.slice(0, 80)}…` : body) : '(no subject)';
}
