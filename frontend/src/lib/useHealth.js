import { useEffect, useState } from 'react';
import { api, USE_MOCK } from '../api/client.js';

// FS-04 — polls GET /api/v1/health. The gateway always answers 200 with status ok | degraded | down
// (down = the engine is unreachable); a failed request means the gateway itself is down.
export function useHealth() {
  const [h, setH] = useState({ state: 'checking' });
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const res = await api.health();
        const state = { ok: 'ok', degraded: 'degraded', down: 'engineDown' }[res?.status] ?? 'degraded';
        if (alive) setH({ state, detail: res });
      } catch (e) {
        if (alive) setH({ state: 'down', error: e.message });
      }
    };
    check();
    const id = setInterval(check, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return h;
}

export const HEALTH = {
  checking: { label: 'Checking engine…', dot: 'bg-slate-400', text: 'text-slate-300' },
  ok: { label: 'Engine running', dot: 'bg-emerald-400', text: 'text-emerald-300' },
  degraded: { label: 'Engine degraded', dot: 'bg-amber-300', text: 'text-amber-300' },
  engineDown: { label: 'Engine unreachable', dot: 'bg-rose-500', text: 'text-rose-300' },
  down: { label: 'Gateway down', dot: 'bg-rose-500', text: 'text-rose-300' },
};

export const healthTitle = (h) =>
  h.error ||
  (h.detail
    ? Object.entries(h.detail)
        .map(([k, v]) => `${k}: ${v && typeof v === 'object' ? Object.entries(v).map(([a, b]) => `${a} ${b}`).join(', ') : v}`)
        .join('\n')
    : HEALTH[h.state].label);

export { USE_MOCK };
