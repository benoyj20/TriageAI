import { Siren } from 'lucide-react';
import { clustersOf, useTickets } from '../state/tickets.jsx';
import { go } from '../lib/useHashRoute.js';

// FS-13 — shown while any open ticket belongs to an active burst cluster.
export default function OutageBanner() {
  const { outage, resolveOutage } = useTickets();
  if (outage.length === 0) return null;
  const clusters = clustersOf(outage).join(', ');
  const queue = outage[0].classification.queue.label;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 bg-red-700 px-4 py-2 text-white">
      <span className="animate-pulse-ring grid h-6 w-6 place-items-center rounded-full bg-white/15">
        <Siren size={14} />
      </span>
      <span className="text-[13px] font-semibold">Major incident · {queue}</span>
      <span className="text-[12.5px] text-red-100">
        {outage.length} ticket{outage.length > 1 ? 's' : ''} joined burst cluster {clusters} and {outage.length > 1 ? 'were' : 'was'} escalated to on-call.
      </span>
      <span className="ml-auto flex gap-2">
        <button onClick={() => go('#/board')} className="rounded border border-white/40 px-2.5 py-1 text-[12px] hover:bg-white/10">View on board</button>
        <button onClick={resolveOutage} className="rounded bg-card px-2.5 py-1 text-[12px] font-medium text-red-800 hover:bg-red-50">Mark resolved</button>
      </span>
    </div>
  );
}
