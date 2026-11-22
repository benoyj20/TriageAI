import { CheckCircle2, Info, Siren, X } from 'lucide-react';
import { useTickets } from '../state/tickets.jsx';

const TONE = {
  info: ['border-brand-600', Info, 'text-brand-600'],
  good: ['border-emerald-600', CheckCircle2, 'text-emerald-600'],
  critical: ['border-red-600', Siren, 'text-red-600'],
};

export default function Toasts() {
  const { toasts, dispatch } = useTickets();
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => {
        const [border, Icon, ic] = TONE[t.tone] ?? TONE.info;
        return (
          <div key={t.id} className={`pointer-events-auto flex items-start gap-2 rounded border-l-4 ${border} bg-card px-3 py-2.5 shadow-lg ring-1 ring-black/5`}>
            <Icon size={16} className={`mt-px shrink-0 ${ic}`} />
            <span className="flex-1 text-[12.5px]">{t.text}</span>
            <button onClick={() => dispatch({ type: 'DISMISS', id: t.id })} className="text-ink-3 hover:text-ink" aria-label="Dismiss"><X size={14} /></button>
          </div>
        );
      })}
    </div>
  );
}
