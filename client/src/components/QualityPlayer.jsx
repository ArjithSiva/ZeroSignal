import { tint } from '../lib/theme.js';
import { useEffect, useRef } from 'react';
import { TIER_META } from '../lib/ui.js';
import { SimBadge } from './Badges.jsx';

/** Internal render resolution per tier (the canvas is then scaled up, so lower tiers look blocky). */
const RES = { '720p': [320, 180], '480p': [160, 90], '240p': [80, 45] };

/**
 * A SIMULATED broadcast feed drawn on a canvas. No real video is streamed anywhere (spec §2):
 * what changes with the tier is how much detail the picture keeps, then video disappears
 * (audio waveform), then everything but text.
 */
export default function QualityPlayer({ tier, headline, action, cachedLabel }) {
  const ref = useRef(null);
  const tierRef = useRef(tier);
  tierRef.current = tier;
  const textRef = useRef({ headline, action });
  textRef.current = { headline, action };

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas.getContext('2d');
    const off = document.createElement('canvas');
    const octx = off.getContext('2d');
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let raf;
    let t0 = performance.now();

    const draw = (now) => {
      const t = (now - t0) / 1000;
      const tr = tierRef.current;
      const [w, h] = RES[tr] ?? [320, 180];
      if (RES[tr]) {
        off.width = w;
        off.height = h;
        const g = octx.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, '#0b2a3a');
        g.addColorStop(1, '#1b1030');
        octx.fillStyle = g;
        octx.fillRect(0, 0, w, h);
        // a drifting "weather map": rotating spiral + a shoreline
        octx.strokeStyle = '#22d3ee';
        octx.lineWidth = Math.max(1, w / 90);
        octx.beginPath();
        for (let a = 0; a < 18; a += 0.15) {
          const rr = a * (h / 40);
          const ang = a + t * 0.8;
          const x = w * 0.62 + Math.cos(ang) * rr;
          const y = h * 0.48 + Math.sin(ang) * rr * 0.8;
          a === 0 ? octx.moveTo(x, y) : octx.lineTo(x, y);
        }
        octx.stroke();
        octx.fillStyle = '#16324a';
        octx.beginPath();
        octx.moveTo(0, h);
        octx.lineTo(0, h * 0.7);
        octx.bezierCurveTo(w * 0.2, h * 0.62, w * 0.3, h * 0.8, w * 0.45, h * 0.72);
        octx.lineTo(w * 0.45, h);
        octx.fill();
        octx.fillStyle = '#ef4444';
        octx.fillRect(0, h - h * 0.16, w, h * 0.16);
        octx.fillStyle = '#fff';
        octx.font = `bold ${Math.round(h * 0.09)}px sans-serif`;
        octx.fillText('LIVE · CYCLONE UPDATE', w * 0.04, h - h * 0.055);
        ctx.imageSmoothingEnabled = tr === '720p';
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
      } else if (tr === 'AUDIO') {
        ctx.fillStyle = '#070b14';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const bars = 36;
        for (let i = 0; i < bars; i++) {
          const v = 0.25 + 0.75 * Math.abs(Math.sin(t * 3 + i * 0.7) * Math.cos(t * 1.3 + i * 0.31));
          const bh = v * canvas.height * 0.5;
          ctx.fillStyle = '#f59e0b';
          ctx.fillRect(20 + i * ((canvas.width - 40) / bars), canvas.height / 2 - bh / 2, ((canvas.width - 40) / bars) * 0.6, bh);
        }
      } else {
        ctx.fillStyle = tr === 'CACHED' ? '#1a0b0b' : '#0b1220';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      if (!still) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const meta = tier ? TIER_META[tier] : null;
  const showText = tier === 'TEXT' || tier === 'CACHED' || tier === 'AUDIO' || !tier;
  return (
    <div data-theme="dark" className="relative overflow-hidden rounded-xl border border-line bg-black text-ink" style={{ aspectRatio: '16 / 9' }}>
      <canvas ref={ref} width={960} height={540} className="size-full" aria-hidden style={{ imageRendering: tier === '240p' || tier === '480p' ? 'pixelated' : 'auto' }} />
      <div className="absolute left-2 top-2 flex gap-1.5">
        <SimBadge label="Simulated feed" />
      </div>
      {meta && (
        <span className="absolute right-2 top-2 rounded-md px-2 py-0.5 font-display text-xs font-bold" style={{ background: tint(meta.color, 20), color: meta.color }}>
          {meta.label}
        </span>
      )}
      {showText && (
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-3 pt-8">
          {tier === 'CACHED' && <p className="text-xs font-semibold text-critical">{cachedLabel ?? 'No signal'}</p>}
          <p className="font-display text-sm font-bold leading-snug sm:text-base">{headline || (tier ? meta.blurb : 'Waiting for the first network reading…')}</p>
          {action && <p className="text-xs text-muted sm:text-sm">{action}</p>}
        </div>
      )}
    </div>
  );
}
