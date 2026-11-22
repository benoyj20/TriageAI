// FS-10 — draft is rendered as plain text. Citations like [TKT-01234] become React elements;
// nothing is ever injected as HTML. Known citations open the cited ticket when `onCite` is given.
const CITE = /\[(TKT-\d{5})\]/g;

export default function DraftText({ text, known = [], onCite, highlight }) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(CITE)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const id = m[1];
    const ok = known.length === 0 || known.includes(id);
    const lit = highlight === id;
    const cls = `mx-0.5 inline-flex items-center rounded px-1 align-baseline font-mono text-[11px] font-semibold transition ${
      !ok ? 'bg-red-100 text-red-700 line-through' : lit ? 'bg-amber-200 text-amber-950 ring-2 ring-amber-400' : 'bg-brand-100 text-brand-700'
    }`;
    parts.push(
      ok && onCite ? (
        <button
          key={`${id}-${m.index}`}
          type="button"
          onClick={() => onCite(id)}
          title="Open the cited ticket"
          className={`${cls} cursor-pointer hover:bg-brand-600 hover:text-white`}
        >
          {id}
        </button>
      ) : (
        <span key={`${id}-${m.index}`} title={ok ? 'Cited precedent' : 'Citation not in retrieved precedents'} className={cls}>
          {id}
        </span>
      ),
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{parts}</div>;
}
