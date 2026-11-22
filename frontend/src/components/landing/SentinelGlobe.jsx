import { useEffect, useRef } from 'react';

// A rotating point-cloud "sentinel" that pulls incoming tickets into its core and sorts them
// into three lanes: auto-reply (teal), review (amber) and escalate (red).
// Plain <canvas> with a hand-rolled 3D projection: no 3D library.

const LANES = [
  { id: 'auto', rgb: '45,212,191', weight: 0.56 },
  { id: 'review', rgb: '251,191,36', weight: 0.32 },
  { id: 'escalate', rgb: '248,113,113', weight: 0.12 },
];
const POINTS = 560;
const MAX_TICKETS = 24;
const TRAIL = 7;

function fibonacciSphere(n) {
  const pts = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = golden * i;
    pts.push([Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  return pts;
}

function pickLane() {
  let r = Math.random();
  for (let i = 0; i < LANES.length; i++) {
    r -= LANES[i].weight;
    if (r <= 0) return i;
  }
  return 0;
}

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const quad = (p0, p1, p2, t) => {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]];
};

export default function SentinelGlobe({ className = '' }) {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return undefined;

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const pts = fibonacciSphere(POINTS);
    const rings = [
      { tx: 1.18, tz: 0.32, r: 1.34, speed: 0.00042 },
      { tx: -0.52, tz: -0.86, r: 1.2, speed: -0.00031 },
    ];
    const ptr = { x: 0, y: 0, tx: 0, ty: 0 };
    let tickets = [];
    let pulses = [];
    let w = 0;
    let h = 0;
    let raf = 0;
    let last = 0;
    let clock = 0;
    let spawnIn = 0;
    let rot = 0.4;

    const geo = () => {
      const R = Math.min(w, h) * (w < 520 ? 0.31 : 0.29);
      return { cx: w * 0.47, cy: h * 0.47, R };
    };

    const lanePath = (i) => {
      const { cx, cy, R } = geo();
      const dy = (i - 1) * R * 0.95;
      return { p0: [cx + R * 0.1, cy], p1: [cx + R * 1.45, cy + dy * 0.15], p2: [w + 28, cy + dy] };
    };

    const spawn = () => {
      const { cx, cy, R } = geo();
      const y = h * (0.12 + Math.random() * 0.76);
      tickets.push({
        phase: 'in',
        t: 0,
        speed: 0.00034 + Math.random() * 0.00016,
        path: { p0: [-24, y], p1: [cx - R * 1.5, (y + cy) / 2 + (Math.random() - 0.5) * R * 0.6], p2: [cx, cy] },
        lane: -1,
        trail: [],
      });
    };

    const step = (dt) => {
      clock += dt;
      rot += dt * 0.00017;
      ptr.x += (ptr.tx - ptr.x) * 0.05;
      ptr.y += (ptr.ty - ptr.y) * 0.05;

      spawnIn -= dt;
      if (spawnIn <= 0 && tickets.length < MAX_TICKETS) {
        spawn();
        spawnIn = 280 + Math.random() * 460;
      }

      for (const tk of tickets) {
        tk.t += dt * tk.speed;
        if (tk.phase === 'in' && tk.t >= 1) {
          tk.phase = 'out';
          tk.t = 0;
          tk.lane = pickLane();
          tk.path = lanePath(tk.lane);
          tk.speed = 0.00036 + Math.random() * 0.00012;
          tk.trail = [];
          pulses.push({ lane: tk.lane, age: 0 });
        }
        const pos = quad(tk.path.p0, tk.path.p1, tk.path.p2, easeInOut(Math.min(1, tk.t)));
        tk.trail.push(pos);
        if (tk.trail.length > TRAIL) tk.trail.shift();
      }
      tickets = tickets.filter((tk) => !(tk.phase === 'out' && tk.t >= 1));
      for (const p of pulses) p.age += dt;
      pulses = pulses.filter((p) => p.age < 900);
    };

    const draw = () => {
      const { cx, cy, R } = geo();
      ctx.clearRect(0, 0, w, h);

      const ox = ptr.x * 14;
      const oy = ptr.y * 10;
      const rotY = rot + ptr.x * 0.55;
      const rotX = 0.32 + ptr.y * 0.4;
      const cY = Math.cos(rotY);
      const sY = Math.sin(rotY);
      const cX = Math.cos(rotX);
      const sX = Math.sin(rotX);
      const project = (x, y, z) => {
        const x1 = x * cY + z * sY;
        const z1 = -x * sY + z * cY;
        const y1 = y * cX - z1 * sX;
        const z2 = y * sX + z1 * cX;
        const persp = 2.8 / (2.8 - z2);
        return [cx + ox + x1 * R * persp, cy + oy + y1 * R * persp, z2];
      };

      // Lane rails: faint curves from the core to the right edge, with a slow flowing dash.
      ctx.lineWidth = 1.2;
      for (let i = 0; i < LANES.length; i++) {
        const { p0, p1, p2 } = lanePath(i);
        ctx.setLineDash([2, 7]);
        ctx.lineDashOffset = reduce ? 0 : -clock * 0.02;
        ctx.strokeStyle = `rgba(${LANES[i].rgb},0.22)`;
        ctx.beginPath();
        ctx.moveTo(p0[0] + ox, p0[1] + oy);
        ctx.quadraticCurveTo(p1[0] + ox * 0.5, p1[1] + oy * 0.5, p2[0], p2[1]);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // Core glow.
      const glow = ctx.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, R * 1.15);
      glow.addColorStop(0, 'rgba(45,212,191,0.20)');
      glow.addColorStop(0.55, 'rgba(37,93,145,0.10)');
      glow.addColorStop(1, 'rgba(8,26,40,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx + ox, cy + oy, R * 1.15, 0, Math.PI * 2);
      ctx.fill();

      // Point-cloud sphere: size and brightness follow depth.
      for (const [x, y, z] of pts) {
        const [sx, sy, d] = project(x, y, z);
        const depth = (d + 1) / 2;
        const a = 0.1 + 0.78 * depth ** 1.6;
        const s = 0.6 + 1.5 * depth;
        ctx.fillStyle = `rgba(94,234,212,${a.toFixed(3)})`;
        ctx.fillRect(sx - s / 2, sy - s / 2, s, s);
      }

      // Orbit rings with a travelling satellite dot.
      for (const ring of rings) {
        const cTx = Math.cos(ring.tx);
        const sTx = Math.sin(ring.tx);
        const cTz = Math.cos(ring.tz);
        const sTz = Math.sin(ring.tz);
        const toWorld = (ang) => {
          let x = Math.cos(ang) * ring.r;
          let y = 0;
          let z = Math.sin(ang) * ring.r;
          const y2 = y * cTx - z * sTx;
          const z2 = y * sTx + z * cTx;
          y = y2;
          z = z2;
          const x3 = x * cTz - y * sTz;
          const y3 = x * sTz + y * cTz;
          return project(x3, y3, z);
        };
        let prev = toWorld(0);
        for (let k = 1; k <= 96; k++) {
          const cur = toWorld((k / 96) * Math.PI * 2);
          const depth = ((prev[2] + cur[2]) / 2 + 1.4) / 2.8;
          ctx.strokeStyle = `rgba(148,197,233,${(0.05 + 0.28 * depth).toFixed(3)})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(prev[0], prev[1]);
          ctx.lineTo(cur[0], cur[1]);
          ctx.stroke();
          prev = cur;
        }
        const [dx, dy, dz] = toWorld(clock * ring.speed);
        ctx.fillStyle = `rgba(186,230,253,${(0.45 + 0.4 * ((dz + 1.4) / 2.8)).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(dx, dy, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }

      // Sorting pulses from the core, in the lane's colour.
      for (const p of pulses) {
        const k = p.age / 900;
        ctx.strokeStyle = `rgba(${LANES[p.lane].rgb},${(0.55 * (1 - k)).toFixed(3)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx + ox, cy + oy, R * (0.18 + 0.9 * k), 0, Math.PI * 2);
        ctx.stroke();
      }

      // Tickets: small cards with a fading trail.
      for (const tk of tickets) {
        const rgb = tk.lane >= 0 ? LANES[tk.lane].rgb : '226,232,240';
        const n = tk.trail.length;
        for (let i = 0; i < n - 1; i++) {
          ctx.strokeStyle = `rgba(${rgb},${((i / n) * 0.35).toFixed(3)})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(tk.trail[i][0], tk.trail[i][1]);
          ctx.lineTo(tk.trail[i + 1][0], tk.trail[i + 1][1]);
          ctx.stroke();
        }
        const [px, py] = tk.trail[n - 1] ?? tk.path.p0;
        const [qx, qy] = tk.trail[n - 2] ?? [px - 1, py];
        const ang = Math.atan2(py - qy, px - qx);
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(ang);
        ctx.shadowColor = `rgba(${rgb},0.9)`;
        ctx.shadowBlur = 8;
        ctx.fillStyle = `rgba(${rgb},0.95)`;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(-5, -3.5, 10, 7, 2);
        else ctx.rect(-5, -3.5, 10, 7);
        ctx.fill();
        ctx.restore();
      }
    };

    const frame = (ts) => {
      const dt = last ? Math.min(48, ts - last) : 16;
      last = ts;
      step(dt);
      draw();
      raf = requestAnimationFrame(frame);
    };

    const staticFrame = () => {
      tickets = [];
      pulses = [];
      for (let i = 0; i < 420; i++) step(16);
      draw();
    };

    const resize = () => {
      const box = canvas.parentElement?.getBoundingClientRect();
      if (!box) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = Math.max(1, box.width);
      h = Math.max(1, box.height);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      tickets = [];
      if (reduce) staticFrame();
    };

    const onPointer = (e) => {
      ptr.tx = Math.max(-1, Math.min(1, (e.clientX / window.innerWidth - 0.5) * 2));
      ptr.ty = Math.max(-1, Math.min(1, (e.clientY / window.innerHeight - 0.5) * 2));
    };

    const start = () => {
      if (reduce || raf) return;
      last = 0;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVisibility = () => (document.hidden ? stop() : start());

    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    resize();
    if (!reduce) {
      window.addEventListener('pointermove', onPointer, { passive: true });
      document.addEventListener('visibilitychange', onVisibility);
      start();
    }

    return () => {
      stop();
      ro.disconnect();
      window.removeEventListener('pointermove', onPointer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      className={className}
      role="img"
      aria-label="A rotating globe pulls in incoming tickets and sorts them into auto-reply, review and escalate lanes"
    />
  );
}
