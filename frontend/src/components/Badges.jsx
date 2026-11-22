import {
  AlertTriangle, ArrowDownCircle, CheckCircle2, Flame, MinusCircle, PenLine, Plus, Siren, ShieldAlert, Sparkles, UserCheck,
} from 'lucide-react';
import { DECISIONS, LANGUAGES, PRIORITIES, REASONS, WORKFLOW } from '../lib/constants.js';
import { pct } from '../lib/format.js';

export function Pill({ className = '', icon: Icon, children, title }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[12px] font-medium leading-4 ${className}`}>
      {Icon && <Icon size={12} strokeWidth={2.4} aria-hidden />}
      {children}
    </span>
  );
}

// Solid red is reserved for "a person must act now"; the other outcomes are tinted.
const DECISION_STYLE = {
  ESCALATE_ONCALL: ['bg-red-600 text-white', Siren],
  HUMAN_REVIEW: ['bg-amber-50 text-amber-900 ring-1 ring-inset ring-amber-300', UserCheck],
  AUTO_DRAFT: ['bg-teal-50 text-teal-800 ring-1 ring-inset ring-teal-200', Sparkles],
};
export function DecisionBadge({ decision, short = false }) {
  const [cls, Icon] = DECISION_STYLE[decision] ?? ['bg-slate-400 text-white', null];
  const meta = DECISIONS[decision];
  return <Pill className={cls} icon={Icon}>{short ? meta?.short : meta?.label ?? decision}</Pill>;
}

const STATUS_STYLE = {
  new: ['bg-sand-2 text-ink-2 ring-1 ring-inset ring-slate-300', Plus],
  escalated: ['bg-red-600 text-white', Siren],
  review: ['bg-amber-50 text-amber-900 ring-1 ring-inset ring-amber-300', UserCheck],
  drafted: ['bg-teal-50 text-teal-800 ring-1 ring-inset ring-teal-200', PenLine],
  resolved: ['bg-sand-2 text-ink-3 ring-1 ring-inset ring-slate-300', CheckCircle2],
};
export function StatusBadge({ status }) {
  const [cls, Icon] = STATUS_STYLE[status] ?? STATUS_STYLE.new;
  return <Pill className={cls} icon={Icon}>{WORKFLOW.find((w) => w.id === status)?.label ?? status}</Pill>;
}

// Priority is text weight and an icon, not a filled pill, so it never competes with the gate decision.
const PRIORITY_STYLE = {
  high: ['font-semibold text-red-700', Flame],
  medium: ['font-medium text-ink-2', MinusCircle],
  low: ['text-ink-3', ArrowDownCircle],
};
export function PriorityBadge({ priority }) {
  const [cls, Icon] = PRIORITY_STYLE[priority] ?? PRIORITY_STYLE.low;
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap text-[13px] leading-4 ${cls}`}>
      <Icon size={13} strokeWidth={2.2} aria-hidden />
      {PRIORITIES[priority]?.label ?? priority}
    </span>
  );
}

export function LangBadge({ code }) {
  const supported = code === 'en' || code === 'de';
  return (
    <span
      title={LANGUAGES[code] ?? code}
      className={`inline-flex h-5.5 min-w-7 items-center justify-center rounded border px-1 text-[11px] font-semibold uppercase tracking-wide ${
        supported ? 'border-slate-300 bg-card text-ink-2' : 'border-amber-400 bg-amber-50 text-amber-800'
      }`}
    >
      {code}
    </span>
  );
}

export function ReasonChip({ code, compact = false }) {
  const r = REASONS[code];
  const p1 = r?.severity === 'P1';
  return (
    <span
      title={r?.hint}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-px text-[11.5px] font-medium ${
        p1 ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-900'
      }`}
    >
      {p1 ? <ShieldAlert size={11} aria-hidden /> : <AlertTriangle size={11} aria-hidden />}
      <span className="font-semibold">{r?.severity}</span>
      {!compact && <span>{r?.label ?? code}</span>}
    </span>
  );
}

export function ConfidenceBar({ value, width = 'w-16' }) {
  const tone = value >= 0.8 ? 'bg-emerald-500' : value >= 0.6 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 ${width} overflow-hidden rounded-full bg-sand-3`}>
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
      <span className="tabular text-[12px] text-ink-2">{pct(value)}</span>
    </span>
  );
}
