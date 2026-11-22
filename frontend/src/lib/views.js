// Ticket views shared by the side rail and the Overview table, so counts always agree.
// Escalated / Human review / Auto-drafted follow the gate decision; Resolved follows the workflow status.
const open = (t) => t.status !== 'resolved';

export const VIEWS = [
  {
    id: 'needs',
    label: 'Needs action',
    blurb: 'Waiting for a person to check the triage before anything is sent.',
    test: (t) => t.review === 'pending' && open(t),
  },
  {
    id: 'escalated',
    label: 'Escalated',
    blurb: 'On-call was paged. Drafts stay held until someone accepts the triage.',
    decision: 'ESCALATE_ONCALL',
    dot: 'bg-red-500',
    rail: true,
    test: (t) => t.gate.decision === 'ESCALATE_ONCALL' && open(t),
  },
  {
    id: 'review',
    label: 'Human review',
    blurb: 'A safety check fired, so a person decides what happens next.',
    decision: 'HUMAN_REVIEW',
    dot: 'bg-amber-400',
    rail: true,
    test: (t) => t.gate.decision === 'HUMAN_REVIEW' && open(t),
  },
  {
    id: 'auto',
    label: 'Auto-drafted',
    blurb: 'No checks fired. Each has a reply grounded in past tickets, ready to send.',
    decision: 'AUTO_DRAFT',
    dot: 'bg-teal-400',
    rail: true,
    test: (t) => t.gate.decision === 'AUTO_DRAFT' && open(t),
  },
  {
    id: 'resolved',
    label: 'Resolved',
    blurb: 'Replied to or closed.',
    dot: 'bg-slate-400',
    rail: true,
    test: (t) => t.status === 'resolved',
  },
  {
    id: 'degraded',
    label: 'Degraded',
    blurb: 'The engine fell back or the draft failed validation.',
    test: (t) => open(t) && t.gate.reasons.some((r) => r.code === 'ENGINE_DEGRADED' || r.code === 'UNGROUNDED_DRAFT'),
  },
];

export const VIEW_BY_ID = Object.fromEntries(VIEWS.map((v) => [v.id, v]));
export const viewHref = (id) => (id === 'needs' ? '#/console' : `#/view/${id}`);
export const countView = (tickets, id) => tickets.filter(VIEW_BY_ID[id].test).length;
