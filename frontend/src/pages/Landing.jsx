import { ArrowRight, LifeBuoy, Radar, ShieldCheck } from 'lucide-react';
import SentinelGlobe from '../components/landing/SentinelGlobe.jsx';
import ImpactCarousel from '../components/landing/ImpactCarousel.jsx';
import './landing.css';

const ROLES = [
  {
    id: 'creator',
    icon: LifeBuoy,
    tag: 'Ticket creator',
    title: 'I need help',
    body: 'Submit a ticket and track it.',
  },
  {
    id: 'manager',
    icon: Radar,
    tag: 'Incident manager',
    title: 'I resolve incidents',
    body: 'Triage console, queues and reports.',
  },
];

const LEGEND = [
  { label: 'Auto-reply', dot: 'bg-teal-300', tip: 'A grounded draft is ready to send' },
  { label: 'Review', dot: 'bg-amber-300', tip: 'A person checks it first' },
  { label: 'Escalate', dot: 'bg-red-400', tip: 'The on-call engineer is paged' },
];

function RoleCard({ role, onChoose, delay }) {
  const Icon = role.icon;
  const onPointerMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
  };
  return (
    <button
      type="button"
      onClick={() => onChoose?.(role.id)}
      onPointerMove={onPointerMove}
      className={`role-card landing-rise group flex w-full items-center gap-4 rounded-2xl border border-white/12 bg-white/[0.035] p-4 text-left sm:p-5 ${
        role.id === 'manager' ? 'is-manager' : ''
      }`}
      style={{ animationDelay: delay }}
    >
      <span className="role-icon grid h-12 w-12 shrink-0 place-items-center rounded-xl">
        <Icon size={22} strokeWidth={2.2} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11.5px] font-semibold tracking-wide text-slate-400 uppercase">{role.tag}</span>
        <span className="mt-0.5 block text-[18px] font-semibold tracking-tight text-white">{role.title}</span>
        <span className="mt-0.5 block text-[13.5px] text-slate-300">{role.body}</span>
      </span>
      <ArrowRight size={20} className="role-arrow shrink-0" aria-hidden />
    </button>
  );
}

export default function Landing({ onChoose }) {
  return (
    <div className="landing relative h-full overflow-x-hidden overflow-y-auto text-white">
      <div className="landing-dots" aria-hidden />

      <div className="relative mx-auto flex min-h-full max-w-6xl flex-col px-4 sm:px-6 lg:px-8">
        <header className="flex h-16 shrink-0 items-center">
          <a href="#/" className="flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-teal-300">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-teal-500 text-brand-950">
              <ShieldCheck size={19} strokeWidth={2.4} aria-hidden />
            </span>
            <span className="text-[16px] font-bold tracking-tight">SentinelDesk</span>
          </a>
        </header>

        <main className="landing-layout flex-1 items-start py-4 sm:py-8 lg:py-10">
          <section className="landing-intro lg:self-center">
            <p className="landing-rise text-[12.5px] font-semibold tracking-wide text-teal-300 uppercase">Incident triage copilot</p>
            <h1
              className="landing-rise mt-3 text-[34px] leading-[1.08] font-bold tracking-tight text-balance sm:text-[44px] lg:text-[52px]"
              style={{ animationDelay: '60ms' }}
            >
              Every ticket,
              <br />
              <span className="text-gradient">triaged in seconds.</span>
            </h1>
            <p className="landing-rise mt-4 max-w-[42ch] text-[15.5px] leading-relaxed text-slate-300" style={{ animationDelay: '120ms' }}>
              Classified, answered from real resolutions, and routed to the right people.
            </p>

            <div role="group" aria-label="Choose how you use SentinelDesk" className="mt-8 grid gap-3 sm:max-w-[520px]">
              {ROLES.map((r, i) => (
                <RoleCard key={r.id} role={r} onChoose={onChoose} delay={`${180 + i * 80}ms`} />
              ))}
            </div>
          </section>

          <section className="landing-globe relative" aria-label="How tickets are sorted">
            <div className="relative h-[250px] sm:h-[340px] lg:h-[420px]">
              <SentinelGlobe className="absolute inset-0 block" />
            </div>
            <div className="mt-1 flex flex-wrap justify-center gap-2 lg:justify-end">
              {LEGEND.map((l) => (
                <span
                  key={l.label}
                  tabIndex={0}
                  data-tip={l.tip}
                  aria-label={`${l.label}: ${l.tip}`}
                  className="flex cursor-default items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[12px] text-slate-200 outline-none focus-visible:ring-2 focus-visible:ring-teal-300"
                >
                  <span className={`h-2 w-2 rounded-full ${l.dot}`} aria-hidden />
                  {l.label}
                </span>
              ))}
            </div>
          </section>

          <div className="landing-carousel landing-rise" style={{ animationDelay: '260ms' }}>
            <ImpactCarousel />
          </div>
        </main>

        <footer className="shrink-0 py-5 text-center text-[12px] text-slate-500">
          SentinelDesk · AI incident triage for IT support teams
        </footer>
      </div>
    </div>
  );
}
