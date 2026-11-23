import { useEffect, useRef, useState } from 'react';
import { BookCheck, ChevronLeft, ChevronRight, Languages, Siren, Timer, Zap } from 'lucide-react';

const INTERVAL_MS = 4500;

// Only real, measured facts. Keep each slide to a headline and one short line.
const SLIDES = [
  { icon: Zap, kicker: 'TriageAI', title: 'Every ticket triaged in seconds', body: 'Type, queue, priority and language, the moment it arrives.' },
  { icon: BookCheck, kicker: 'Grounded replies', stat: '42,675', title: 'resolved tickets behind every draft', body: 'Drafts cite real past resolutions. No invented refunds, prices or promises.' },
  { icon: Siren, kicker: 'Never miss an outage', stat: '87%', title: 'of high-priority incidents caught', body: 'On unseen tickets. Bursts of the same failure raise a major-incident alert.' },
  { icon: Languages, kicker: 'English and German', title: "Replies in the customer's language", body: 'Personal data is masked before any AI sees it.' },
  { icon: Timer, kicker: 'Fast', stat: '~2 s', title: 'from ticket to triage', body: 'Classification, precedents, draft and escalation in one pass.' },
];

function usePrefersReducedMotion() {
  const [reduce, setReduce] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return undefined;
    const on = () => setReduce(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduce;
}

export default function ImpactCarousel({ className = '' }) {
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const reduce = usePrefersReducedMotion();
  const rootRef = useRef(null);
  const n = SLIDES.length;
  const paused = hovered || focused || reduce;

  useEffect(() => {
    if (paused) return undefined;
    const t = setTimeout(() => setIndex((i) => (i + 1) % n), INTERVAL_MS);
    return () => clearTimeout(t);
  }, [index, paused, n]);

  const go = (i) => setIndex(((i % n) + n) % n);

  const onKeyDown = (e) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      go(index + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      go(index - 1);
    }
  };

  return (
    <section
      ref={rootRef}
      className={`impact-carousel relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04] p-5 backdrop-blur-md sm:p-6 ${className}`}
      role="region"
      aria-roledescription="carousel"
      aria-label="What TriageAI does"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget)) setFocused(false);
      }}
      onKeyDown={onKeyDown}
    >
      <div className="grid" aria-live={paused ? 'polite' : 'off'}>
        {SLIDES.map((s, i) => {
          const Icon = s.icon;
          const active = i === index;
          return (
            <div
              key={s.kicker}
              role="group"
              aria-roledescription="slide"
              aria-label={`${i + 1} of ${n}: ${s.kicker}`}
              aria-hidden={!active}
              inert={!active ? true : undefined}
              className={`impact-slide [grid-area:1/1] ${active ? 'is-active' : ''}`}
            >
              <div className="flex items-center gap-2 text-[12px] font-semibold tracking-wide text-teal-300 uppercase">
                <Icon size={15} aria-hidden />
                {s.kicker}
              </div>
              <p className="mt-3 text-[22px] leading-tight font-semibold tracking-tight text-white sm:text-[24px]">
                {s.stat && <span className="text-gradient mr-2 tabular">{s.stat}</span>}
                {s.title}
              </p>
              <p className="mt-2 max-w-[44ch] text-[14px] leading-relaxed text-slate-300">{s.body}</p>
            </div>
          );
        })}
      </div>

      <div className="mt-5 flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          {SLIDES.map((s, i) => (
            <button
              key={s.kicker}
              type="button"
              onClick={() => go(i)}
              aria-label={`Show slide ${i + 1}: ${s.kicker}`}
              aria-current={i === index ? 'true' : undefined}
              data-tip={s.kicker}
              className={`carousel-dot h-1.5 rounded-full transition-all focus-visible:ring-2 focus-visible:ring-teal-300 focus-visible:outline-none ${
                i === index ? 'w-6 bg-teal-300' : 'w-1.5 bg-white/25 hover:bg-white/50'
              }`}
            />
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => go(index - 1)}
            aria-label="Previous slide"
            className="grid h-8 w-8 place-items-center rounded-full text-slate-300 transition hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-teal-300 focus-visible:outline-none"
          >
            <ChevronLeft size={16} aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => go(index + 1)}
            aria-label="Next slide"
            className="grid h-8 w-8 place-items-center rounded-full text-slate-300 transition hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-teal-300 focus-visible:outline-none"
          >
            <ChevronRight size={16} aria-hidden />
          </button>
        </div>
      </div>

      {!reduce && (
        <span
          key={index}
          className="carousel-progress absolute bottom-0 left-0 h-[2px] w-full bg-gradient-to-r from-teal-400 to-sky-400"
          data-paused={paused ? 'true' : 'false'}
          aria-hidden
        />
      )}
    </section>
  );
}
