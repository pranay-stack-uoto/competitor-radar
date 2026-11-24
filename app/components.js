'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { ConsentGate } from './consent';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Colour for each score area, defined once in the stylesheet so light and dark themes stay in step.
export const AREA_COLOR = { overall: 'var(--c-overall)', seo: 'var(--c-seo)', geo: 'var(--c-geo)', local: 'var(--c-local)', keywords: 'var(--c-keywords)' };
export const PALETTE = ['#94a3b8', '#f59e0b', '#14b8a6', '#ec4899', '#8b5cf6'];

// 0 -> 1 with easing, restarted whenever `dep` changes. Skipped entirely for people who ask for reduced motion.
export function useProgress(ms = 900, delay = 0, dep) {
  const [p, setP] = useState(0);
  useEffect(() => {
    if (reduced()) { setP(1); return; }
    setP(0);
    let raf, t0;
    const tm = setTimeout(() => {
      const step = (t) => { t0 ??= t; const k = Math.min(1, (t - t0) / ms); setP(1 - Math.pow(1 - k, 3)); if (k < 1) raf = requestAnimationFrame(step); };
      raf = requestAnimationFrame(step);
    }, delay);
    return () => { clearTimeout(tm); cancelAnimationFrame(raf); };
  }, [ms, delay, dep]);
  return p;
}

// A number that counts up (or from its previous value) instead of jumping.
export function AnimatedNumber({ value, decimals = 0, ms = 800 }) {
  const [v, setV] = useState(reduced() ? Number(value) || 0 : 0);
  const from = useRef(0);
  useEffect(() => {
    const to = Number(value) || 0;
    if (reduced()) { setV(to); from.current = to; return; }
    const a = from.current;
    let raf, t0;
    const step = (t) => { t0 ??= t; const k = Math.min(1, (t - t0) / ms); setV(a + (to - a) * (1 - Math.pow(1 - k, 3))); if (k < 1) raf = requestAnimationFrame(step); else from.current = to; };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{v.toFixed(decimals)}</>;
}

// Air-traffic radar: range rings, a sweeping beam and one contact.
export const Logo = () => (
  <span className="logo" aria-hidden="true">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" opacity=".6" />
      <circle cx="12" cy="12" r="5.6" stroke="currentColor" strokeWidth="1.3" opacity=".45" />
      <path d="M12 12 L12 2 A10 10 0 0 1 21.5 8.9 Z" fill="currentColor" opacity=".32" />
      <path d="M12 12 L12 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="17.2" cy="8.4" r="1.7" fill="currentColor" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" />
    </svg>
  </span>
);

export function Nav({ right }) {
  const path = usePathname();
  const tab = (href, label) => <Link key={href} href={href} className={'tab' + (path === href ? ' on' : '')}>{label}</Link>;
  return (
    <div className="nav no-print"><ConsentGate /><div className="nav-in">
      <Link href="/dashboard" className="brand"><Logo /><span className="brand-t">Competitor Radar</span></Link>
      <div className="tabs">{tab('/dashboard', 'Overview')}{tab('/report', 'Report')}</div>
      <div className="nav-actions">{right}</div>
    </div></div>
  );
}

export const tone = (v) => (v >= 70 ? 'var(--good)' : v >= 45 ? 'var(--warn)' : 'var(--bad)');

export function ScoreRing({ value = 0, size = 132, label = 'overall', color }) {
  const p = useProgress(1100);
  const r = (size - 14) / 2, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, value));
  const col = color || tone(v);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Score ${Math.round(v)} out of 100`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth="9" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={col} strokeWidth="9" strokeLinecap="round" strokeDasharray={`${(v / 100) * c * p} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="49%" textAnchor="middle" dominantBaseline="middle" fontSize={size * 0.3} fontWeight="700" fill="var(--ink)" letterSpacing="-1"><AnimatedNumber value={v} /></text>
      <text x="50%" y="69%" textAnchor="middle" fontSize="11" fill="var(--mute)">{label}</text>
    </svg>
  );
}

export function Change({ v, unit = '' }) {
  if (v == null) return <span className="muted">–</span>;
  if (v > 0) return <span className="up">▲ {v}{unit}</span>;
  if (v < 0) return <span className="down">▼ {Math.abs(v)}{unit}</span>;
  return <span className="muted">=</span>;
}

export function CellBar({ v, color }) {
  const n = v == null ? 0 : Math.round(v);
  return <span className="cell-bar"><span>{n}</span><i><b style={{ width: `${n}%`, background: color || tone(n) }} /></i></span>;
}

// Small line that draws itself. Needs two or more points.
export function Sparkline({ points, color = 'var(--accent)', w = 92, h = 28 }) {
  const id = useId().replace(/:/g, '');
  if (!points || points.length < 2) return null;
  const min = Math.min(...points), max = Math.max(...points), span = max - min || 1;
  const xy = points.map((v, i) => [2 + (i / (points.length - 1)) * (w - 4), 3 + (1 - (v - min) / span) * (h - 6)]);
  const d = xy.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" style={{ display: 'block' }}>
      <defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".22" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      <path d={`${d} L${xy[xy.length - 1][0]} ${h} L${xy[0][0]} ${h} Z`} fill={`url(#${id})`} className="fade" />
      <path d={d} pathLength="1" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="draw" />
      <circle cx={xy[xy.length - 1][0]} cy={xy[xy.length - 1][1]} r="2.6" fill={color} className="fade" />
    </svg>
  );
}

// Lines over time with a hover read-out, like Search Console. series: [{ name, color, bold, points: { day: value } }]
export function Trend({ series, days, height = 220, area = true }) {
  const [hover, setHover] = useState(null);
  const ref = useRef(null);
  const gid = useId().replace(/:/g, '');
  if (!days.length) return null;
  const W = 720, H = height, L = 34, R = 22, T = 12, B = 24;
  const vals = series.flatMap((s) => Object.values(s.points)).filter((v) => v != null);
  const lo = Math.max(0, Math.floor((Math.min(...vals, 100) - 6) / 10) * 10), hi = Math.min(100, Math.ceil((Math.max(...vals, 0) + 6) / 10) * 10);
  const yMin = Math.min(lo, 40), yMax = Math.max(hi, 60);
  const x = (i) => (days.length < 2 ? (L + W - R) / 2 : L + (i / (days.length - 1)) * (W - L - R));
  const y = (v) => T + (1 - (v - yMin) / (yMax - yMin)) * (H - T - B);
  const ticks = [0, 1, 2, 3].map((i) => Math.round(yMin + ((yMax - yMin) * i) / 3));
  const onMove = (e) => {
    const r = ref.current.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(days.length - 1, Math.round(((px - L) / (W - L - R)) * (days.length - 1) || 0))));
  };
  const hv = hover != null ? days[hover] : null;
  return (
    <div style={{ position: 'relative' }} ref={ref} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Score over time" style={{ display: 'block' }}>
        {ticks.map((t) => <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeDasharray={t === yMin ? '' : '3 4'} /><text x={L - 8} y={y(t) + 4} textAnchor="end" fontSize="10.5" fill="var(--mute)">{t}</text></g>)}
        {days.map((d, i) => (days.length <= 7 || i % Math.ceil(days.length / 7) === 0) && <text key={d} x={x(i)} y={H - 6} textAnchor="middle" fontSize="10.5" fill="var(--mute)">{d.slice(5)}</text>)}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="var(--mute)" strokeDasharray="3 3" />}
        {series.map((s, si) => {
          const pts = days.map((d, i) => (s.points[d] != null ? [x(i), y(s.points[d]), d] : null)).filter(Boolean);
          const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
          return (
            <g key={s.name} opacity={hover != null && !s.bold ? 0.85 : 1}>
              {area && s.bold && pts.length > 1 && <><defs><linearGradient id={gid + si} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={s.color} stopOpacity=".2" /><stop offset="1" stopColor={s.color} stopOpacity="0" /></linearGradient></defs><path d={`${line} L${pts[pts.length - 1][0]} ${H - B} L${pts[0][0]} ${H - B} Z`} fill={`url(#${gid + si})`} className="fade" /></>}
              {pts.length > 1 && <path d={line} pathLength="1" fill="none" stroke={s.color} strokeWidth={s.bold ? 2.6 : 1.7} strokeLinecap="round" strokeLinejoin="round" className="draw" style={{ animationDelay: `${si * 90}ms` }} />}
              {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={p[2] === hv ? 5 : s.bold ? 3.6 : 2.6} fill={p[2] === hv ? s.color : 'var(--card)'} stroke={s.color} strokeWidth="2" className="fade" />)}
            </g>
          );
        })}
      </svg>
      {hv && (
        <div className="chart-tip" style={{ left: `${Math.min(78, Math.max(2, (x(hover) / W) * 100 + 2))}%`, top: 6 }}>
          <div style={{ opacity: 0.7, marginBottom: 2 }}>{hv}</div>
          {series.filter((s) => s.points[hv] != null).sort((a, b) => b.points[hv] - a.points[hv]).map((s) => <div key={s.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}><span><span style={{ color: s.color }}>●</span> {s.name.replace(' (you)', '')}{s.bold ? ' (you)' : ''}</span><b>{Math.round(s.points[hv] * 10) / 10}</b></div>)}
        </div>
      )}
      <div className="legend">{series.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}</div>
    </div>
  );
}

// Radar grows out from the centre. series: [{ name, color, values: { seo, geo, local, keywords }, bold }]
export function Radar({ series, size = 300 }) {
  const p = useProgress(1000);
  const axes = [['seo', 'SEO'], ['geo', 'AI / GEO'], ['local', 'Local'], ['keywords', 'Keywords']];
  const c = size / 2, R = size / 2 - 62;
  const pt = (i, v) => { const a = (-90 + (360 / axes.length) * i) * Math.PI / 180; return [c + Math.cos(a) * R * (v / 100), c + Math.sin(a) * R * (v / 100)]; };
  return (
    <div>
      <svg viewBox={`0 0 ${size} ${size}`} width="100%" style={{ maxWidth: size, display: 'block', margin: '0 auto' }} role="img" aria-label="Scores by area compared with competitors">
        {[25, 50, 75, 100].map((r) => <polygon key={r} points={axes.map((_, i) => pt(i, r).join(',')).join(' ')} fill="none" stroke="var(--line)" />)}
        {axes.map(([k, l], i) => { const [x, y] = pt(i, 100), [lx, ly] = pt(i, 122); return <g key={k}><line x1={c} y1={c} x2={x} y2={y} stroke="var(--line)" /><text x={lx} y={ly + 4} textAnchor="middle" fontSize="11.5" fill="var(--ink2)">{l}</text></g>; })}
        {series.map((s) => <polygon key={s.name} points={axes.map(([k], i) => pt(i, (s.values[k] || 0) * p).join(',')).join(' ')} fill={s.color} fillOpacity={s.bold ? 0.2 : 0.04} stroke={s.color} strokeWidth={s.bold ? 2.4 : 1.4} strokeDasharray={s.bold ? '' : '4 3'} strokeLinejoin="round" />)}
        {series.filter((s) => s.bold).map((s) => axes.map(([k], i) => { const [x, y] = pt(i, (s.values[k] || 0) * p); return <circle key={s.name + k} cx={x} cy={y} r="3.6" fill={s.color} />; }))}
      </svg>
      <div className="legend" style={{ justifyContent: 'center' }}>{series.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}</div>
    </div>
  );
}

// Simple labelled bars that fill in. items: [{ label, value, color, highlight, note }]
export function BarList({ items, max = 100, unit = '' }) {
  const p = useProgress(900);
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {items.map((it) => (
        <div key={it.label}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 3, gap: 8 }}>
            <span style={{ fontWeight: it.highlight ? 650 : 450, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
            <span className="sub">{it.note ?? `${Math.round(it.value)}${unit}`}</span>
          </div>
          <div className="track" style={{ margin: 0 }}><div className="fill" style={{ width: `${Math.max(2, Math.min(100, (it.value / max) * 100)) * p}%`, background: it.color || (it.highlight ? 'var(--accent)' : 'var(--mute)') }} /></div>
        </div>
      ))}
    </div>
  );
}

// Ranked horizontal bars for one metric. Staggered fill; you are highlighted. `animKey` restarts the animation.
export function HBars({ items, animKey, color = 'var(--accent)', marker }) {
  const p = useProgress(900, 0, animKey);
  return (
    <div>
      {items.map((it, i) => {
        const k = Math.max(0, Math.min(1, p * 1.4 - i * 0.05));
        return (
          <div className="hbar" key={it.label}>
            <span className={'rankdot' + (it.you ? ' first' : '')}>{i + 1}</span>
            <div style={{ minWidth: 0 }}>
              <div className="hbar-name" style={{ fontWeight: it.you ? 650 : 450 }}>{it.label}{it.you && <span className="pill neutral" style={{ marginLeft: 8 }}>you</span>}</div>
              <div className="hbar-track"><div className="hbar-fill" style={{ width: `${Math.max(1.5, it.value) * k}%`, background: it.you ? color : 'color-mix(in srgb, var(--mute) 55%, transparent)' }} />{marker != null && i === 0 && null}</div>
            </div>
            <span className="tabnum" style={{ textAlign: 'right', fontWeight: it.you ? 650 : 500, fontVariantNumeric: 'tabular-nums' }}>{Math.round(it.value * k)}</span>
          </div>
        );
      })}
    </div>
  );
}
