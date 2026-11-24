'use client';
import { useState } from 'react';
import { AREA_COLOR, PALETTE, AnimatedNumber, Sparkline, HBars, Trend, Radar, Change, CellBar } from './components';

export const METRICS = [
  { key: 'overall', label: 'Overall', blurb: 'All four areas combined' },
  { key: 'seo', label: 'SEO content', blurb: 'How well your pages are built to rank' },
  { key: 'geo', label: 'AI visibility', blurb: 'How easily AI assistants can find and cite you' },
  { key: 'local', label: 'Local search', blurb: 'How clearly you show up in your cities' },
  { key: 'keywords', label: 'Keywords', blurb: 'How well pages target what people search' },
];
const num = (v) => Math.round(Number(v) * 10) / 10;

// Per-day values of one metric for one site, oldest first.
function seriesFor(hist, domain, key) {
  return [...hist].filter((h) => h.domain === domain && h[key] != null).sort((a, b) => (a.day < b.day ? -1 : 1)).map((h) => ({ day: h.day, v: Number(h[key]) }));
}

// The row of score tiles. Click one and the charts and table below switch to that area.
export function Tiles({ project, board, hist, sel, setSel }) {
  const me = board.find((b) => b.is_me);
  return (
    <div className="grid g5">
      {METRICS.map((m, i) => {
        const val = Number(me?.[m.key] || 0);
        const best = Math.max(...board.filter((b) => !b.is_me).map((b) => Number(b[m.key] || 0)), 0);
        const hs = seriesFor(hist, project.domain, m.key);
        const delta = hs.length > 1 ? num(hs[hs.length - 1].v - hs[hs.length - 2].v) : null;
        const lead = val >= best;
        return (
          <button key={m.key} className={'tile rise' + (sel === m.key ? ' on' : '')} style={{ '--c': AREA_COLOR[m.key], '--i': i }} onClick={() => setSel(m.key)} aria-pressed={sel === m.key}>
            <div className="tile-l"><i />{m.label}</div>
            <div className="tile-v"><AnimatedNumber value={val} decimals={m.key === 'overall' ? 1 : 0} /><small>/100</small></div>
            <div className="tile-f">
              <span style={{ lineHeight: 1.45 }}>
                <span style={{ display: 'block', whiteSpace: 'nowrap' }}>{delta != null && delta !== 0 ? <b className={delta > 0 ? 'up' : 'down'}>{delta > 0 ? '▲' : '▼'} {Math.abs(delta)} today</b> : <span className="muted">{delta === 0 ? 'No change' : 'First report'}</span>}</span>
                <span style={{ display: 'block', whiteSpace: 'nowrap' }}>{board.length > 1 ? (lead ? 'You lead' : `Best ${Math.round(best)}`) : 'No competitors yet'}</span>
              </span>
              <Sparkline points={hs.map((h) => h.v)} color={AREA_COLOR[m.key]} w={64} />
            </div>
          </button>
        );
      })}
    </div>
  );
}

// Main chart, with a Compare / Trend switch. Compare works from the very first report; Trend needs two days.
export function ChartCard({ project, board, hist, sel }) {
  const days = [...new Set(hist.map((h) => h.day))].sort();
  const [mode, setMode] = useState(null);
  const view = mode || (days.length > 1 ? 'trend' : 'compare');
  const m = METRICS.find((x) => x.key === sel);
  const ranked = [...board].sort((a, b) => Number(b[sel] || 0) - Number(a[sel] || 0));
  const top = ranked.slice(0, 5).map((b) => b.domain);
  if (!top.includes(project.domain)) top.push(project.domain);
  const series = top.map((dom, i) => {
    const mineSite = dom === project.domain;
    return { name: mineSite ? `${dom} (you)` : dom, color: mineSite ? AREA_COLOR[sel] : PALETTE[i % PALETTE.length], bold: mineSite, points: Object.fromEntries(seriesFor(hist, dom, sel).map((h) => [h.day, h.v])) };
  });
  const myRank = ranked.findIndex((b) => b.is_me) + 1;
  return (
    <div className="card pad rise" style={{ '--i': 5 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <div><h2>{m.label}</h2><div className="sub">{m.blurb}{myRank > 0 && board.length > 1 ? ` · you are #${myRank} of ${board.length}` : ''}</div></div>
        <div className="seg no-print">
          <button className={view === 'compare' ? 'on' : ''} onClick={() => setMode('compare')}>Compare</button>
          <button className={view === 'trend' ? 'on' : ''} onClick={() => setMode('trend')}>Trend</button>
        </div>
      </div>
      {view === 'compare'
        ? <HBars animKey={sel} color={AREA_COLOR[sel]} items={ranked.slice(0, 10).map((b) => ({ label: b.domain, value: Number(b[sel] || 0), you: b.is_me }))} />
        : days.length < 2
          ? <div className="empty" style={{ padding: '60px 20px' }}>The trend appears after your second daily report.</div>
          : <Trend key={sel} series={series} days={days} height={270} />}
      {view === 'trend' && methodNote(hist)}
    </div>
  );
}

// When the scoring method changed during the period shown, say so: scores on either side are not directly comparable.
function methodNote(hist) {
  const versions = [...new Set(hist.map((h) => h.method_version || 1))].sort((a, b) => a - b);
  if (versions.length < 2) return null;
  const latest = versions[versions.length - 1];
  const since = hist.filter((h) => (h.method_version || 1) === latest).map((h) => h.day).sort()[0];
  return <div className="sub" style={{ marginTop: 8, fontSize: 12.5 }}>The scoring method was updated on {since}. Scores before that date used an earlier method and are not directly comparable.</div>;
}

export function RadarCard({ project, board, me }) {
  const top = [...board].filter((b) => !b.is_me).sort((a, b) => b.overall - a.overall).slice(0, 3);
  const series = [
    { name: `${project.domain} (you)`, color: 'var(--accent)', bold: true, values: { seo: me?.seo, geo: me?.geo, local: me?.local, keywords: me?.keywords } },
    ...top.map((b, i) => ({ name: b.domain, color: PALETTE[i + 1], values: { seo: b.seo, geo: b.geo, local: b.local, keywords: b.keywords } })),
  ];
  return (
    <div className="card pad rise" style={{ '--i': 6 }}>
      <h2>Your shape</h2><div className="sub" style={{ marginBottom: 6 }}>Strengths against the top three competitors</div>
      <Radar series={series} size={300} />
    </div>
  );
}

// Sortable leaderboard. Sorted by the metric chosen in the tiles unless you click a column.
export function Leaderboard({ board, sel, setSel }) {
  const cols = [['overall', 'Overall'], ['seo', 'SEO'], ['geo', 'AI'], ['local', 'Local'], ['keywords', 'Keywords']];
  const rows = [...board].sort((a, b) => Number(b[sel] || 0) - Number(a[sel] || 0));
  return (
    <div className="card rise" style={{ '--i': 7 }}>
      <div className="card-head"><div><h2>Leaderboard</h2><div className="sub">Click a column to rank by it</div></div></div>
      <div className="tbl-wrap" style={{ marginTop: 6 }}><table>
        <thead><tr>
          <th style={{ width: 40 }}>#</th><th>Site</th>
          {cols.map(([k, l]) => <th key={k} className={'r sort' + (sel === k ? ' on' : '')} onClick={() => setSel(k)} style={sel === k ? { boxShadow: `inset 0 -2px 0 ${AREA_COLOR[k]}` } : undefined}>{l}</th>)}
          <th className="r" title="Link-based authority from Open PageRank, 0 to 10. Not the same measure as Ahrefs Domain Rating.">Authority</th><th className="r">Move</th>
        </tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={r.domain} className={r.is_me ? 'me' : ''}>
            <td><span className={'rankdot' + (i === 0 ? ' first' : '')}>{i + 1}</span></td>
            <td><a className="sitelink" href={'https://' + r.domain} target="_blank" rel="noopener noreferrer" title={`Open ${r.domain} in a new tab`}>{r.domain}<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M4.5 2H2.5A1 1 0 0 0 1.5 3v6.5a1 1 0 0 0 1 1H9a1 1 0 0 0 1-1v-2M7 1.5h3.5V5M10.5 1.5 5.5 6.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg></a>{r.is_me && <> <span className="pill neutral">you</span></>}</td>
            {cols.map(([k]) => <td key={k} className="r" style={sel === k ? { fontWeight: 650 } : undefined}>{k === 'overall' ? <b>{num(r[k])}</b> : <CellBar v={r[k]} color={AREA_COLOR[k]} />}</td>)}
            <td className="r">{r.authority == null ? <span className="sub">–</span> : <>{num(r.authority)}<span className="sub">/10</span></>}</td>
            <td className="r"><Change v={r.scoreChange} /></td>
          </tr>))}</tbody>
      </table></div>
    </div>
  );
}
