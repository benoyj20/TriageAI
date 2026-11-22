import Modal from './Modal.jsx';
import { DecisionBadge, LangBadge, Pill, PriorityBadge, StatusBadge } from './Badges.jsx';
import { DECISIONS, LANGUAGES, REASONS } from '../lib/constants.js';
import { overallConfidence, pct } from '../lib/format.js';
import { ticketHref } from '../lib/useHashRoute.js';
import { Sparkles } from 'lucide-react';

const routeText = (r, found) => {
  if (!r.fallback_global) return `Searched inside ${r.searched.join(' and ') || 'the top queue'}.`;
  return found
    ? 'The routed queues matched weakly, so precedents came from a search across all queues.'
    : 'The routed queues matched weakly, and a search across all queues found nothing similar either.';
};

// "Why did the AI decide this?" — opened from the sparkle icon in the dashboard table.
export default function DetailsModal({ ticket: t, onClose }) {
  const c = t.classification;
  const reasoning = [
    { k: 'Queue', v: `${c.queue.label} — ${c.queue.votes}/${c.queue.k} nearest precedents agree (${pct(c.queue.confidence)} calibrated).` },
    { k: 'Type', v: `${c.type.label} (${pct(c.type.confidence)}).` },
    { k: 'Priority', v: `${c.priority.label}, P(high) = ${c.priority.p_high.toFixed(2)}.` },
    {
      k: 'Precedent',
      v: t.precedents.length
        ? `Closest match ${t.precedents[0].ticket_id} at ${t.precedents[0].similarity.toFixed(2)} similarity.`
        : 'No similar ticket in the knowledge base, so the reply is a holding message.',
    },
    { k: 'Routing', v: routeText(t.retrieval.route, t.precedents.length) },
    { k: 'Language', v: `${LANGUAGES[t.language.code] ?? t.language.code} (${pct(t.language.confidence)}).` },
  ];

  return (
    <Modal title="Details" onClose={onClose} width="max-w-[560px]">
      <div className="grid grid-cols-3 gap-4 border-b border-line pb-4">
        <Field label="Gate decision"><DecisionBadge decision={t.gate.decision} /></Field>
        <Field label="Confidence score"><span className="text-[13px]">{pct(overallConfidence(t))}</span></Field>
        <Field label="Method">
          <Pill className="bg-brand-100 text-brand-700" icon={Sparkles}>{DECISIONS[t.gate.decision].method}</Pill>
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-4 border-b border-line py-4">
        <Field label="Ticket">
          <a href={ticketHref(t.ticket_id)} onClick={onClose} className="text-[13px] text-brand-600 hover:underline">{t.ticket_id}</a>
        </Field>
        <Field label="Status"><StatusBadge status={t.status} /></Field>
        <Field label="Priority">
          <span className="flex items-center gap-1.5"><PriorityBadge priority={c.priority.label} /><LangBadge code={t.language.code} /></span>
        </Field>
      </div>
      <div className="pt-4">
        <div className="mb-1.5 text-[13px] font-semibold">Reasoning:</div>
        <ul className="list-disc space-y-1 pl-5 text-[12.5px] leading-snug text-ink-2">
          {reasoning.map((r) => (
            <li key={r.k}><span className="font-semibold text-ink">{r.k}:</span> {r.v}</li>
          ))}
        </ul>
        <div className="mt-3 mb-1.5 text-[13px] font-semibold">Gate reasons:</div>
        {t.gate.reasons.length === 0 ? (
          <p className="text-[12.5px] text-ink-2">No reasons fired, so the grounded draft can be sent after a quick check.</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5 text-[12.5px] leading-snug text-ink-2">
            {t.gate.reasons.map((r) => (
              <li key={r.code}>
                <span className={`font-semibold ${r.severity === 'P1' ? 'text-red-700' : 'text-amber-800'}`}>{r.severity} · {REASONS[r.code]?.label ?? r.code}:</span> {r.detail}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div className="mb-1 text-[12px] font-medium text-ink-2">{label}</div>
      {children}
    </div>
  );
}
