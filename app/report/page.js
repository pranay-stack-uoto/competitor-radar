'use client';
import { useEffect, useMemo, useState } from 'react';
import { siteRecord, buildFindings } from '@/lib/industry';
import { gbpSummary } from '@/lib/gbp';
import Link from 'next/link';
import { sb } from '@/lib/supabase-browser';
import { loadProjectData } from '@/lib/data';
import { AREAS, EFFORT, buildPlan, sectorSummary } from '@/lib/recommendations';
import { competitorPlaybook, contentGaps, techAudit, buildBrief, attachTargets } from '@/lib/report';
import { markDone, undoDone } from '@/lib/fixes';
import { gscInsights } from '@/lib/gscView';
import { Nav, ScoreRing, Change, Radar, BarList, Trend, tone } from '../components';

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const COLORS = ['#94a3b8', '#f59e0b', '#14b8a6', '#ec4899', '#8b5cf6'];
const save = (name, text, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); };

export default function Report() {
  const [d, setD] = useState(null);
  const [ai, setAi] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState('');
  const [collecting, setCollecting] = useState(false);
  const [sel, setSel] = useState('all');
  useEffect(() => { loadProjectData().then((r) => { if (r) { setD(r); setAi(r.report?.summary?.ai || null); } }); }, []);

  // If this site's stored scores predate detailed profiles, collect them now so the report is specific, not generic.
  const needsDetail = !!d?.me && (!d.me.details?.profile || d.others.slice().sort((a, b) => b.overall - a.overall).slice(0, 3).some((o) => !o.details?.profile));
  useEffect(() => {
    if (!needsDetail || !d) return;
    let stop = false;
    (async () => {
      setCollecting(true);
      for (let i = 0; i < 12 && !stop; i++) {
        const t = (await sb().auth.getSession()).data.session?.access_token;
        const r = await fetch('/api/project/nudge', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: JSON.stringify({ projectId: d.project.id, rescan: i === 0 }) });
        const j = await r.json().catch(() => ({}));
        if (!j.pending) break;
      }
      const fresh = await loadProjectData();
      if (fresh && !stop) { setD(fresh); setAi(fresh.report?.summary?.ai || ai); }
      setCollecting(false);
    })();
    return () => { stop = true; };
  }, [!!needsDetail, d?.project?.id]);

  const model = useMemo(() => {
    if (!d?.me) return null;
    const rows = (d.me.details?.keywords?.extra?.rows || []).map((r) => {
      const best = {};
      for (const h of d.serp.filter((x) => x.keyword === r.keyword)) best[h.domain] = Math.min(best[h.domain] ?? 99, h.position);
      return { ...r, mineBest: best[d.project.domain] ?? null, top: Object.entries(best).filter(([dom]) => dom !== d.project.domain).sort((a, b) => a[1] - b[1]).slice(0, 3) };
    });
    return { keywordRows: rows, playbook: competitorPlaybook(d.me, d.others, d.serp, d.project.domain), gaps: contentGaps(d.me, d.others, d.project.domain), audit: techAudit(d.me.details?.profile) };
  }, [d]);

  async function generateAi(force) {
    setAiBusy(true); setAiMsg('');
    const t = (await sb().auth.getSession()).data.session?.access_token;
    const r = await fetch('/api/report/insights', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: JSON.stringify({ projectId: d.project.id, force }) });
    const j = await r.json();
    setAiBusy(false);
    if (r.ok) { setAi(j.ai); return j.ai; }
    setAiMsg(j.error || 'Could not generate insights.');
    return null;
  }

  const nav = <><button className="ghost small" onClick={() => window.print()}>Download PDF</button><Link className="btn ghost small" href="/dashboard">Back</Link></>;
  if (!d) return <><Nav right={nav} /><div className="wrap"><div className="skeleton" style={{ height: 300 }} /></div></>;
  if (!d.report || !d.me) return <><Nav right={nav} /><div className="wrap"><div className="card empty">Your first report is still being prepared. Come back in a few minutes.</div></div></>;

  const { project, report, me, actions, best, avg, others, hist } = d;
  const { keywordRows, playbook, gaps, audit } = model;
  const ind = (() => {
    try {
      const mineRec = siteRecord(project.domain, me.overall, me.details?.profile);
      const rest = others.map((o) => siteRecord(o.domain, o.overall, o.details?.profile)).filter(Boolean);
      return buildFindings(mineRec, rest, (d.industry || []).filter((h) => h.day < report.day));
    } catch { return { benchmark: null, findings: [] }; }
  })();
  const gbp = (() => {
    try {
      const doms = [{ domain: project.domain, name: project.name && project.name !== project.domain ? project.name : project.domain.split('.')[0], isMe: true }, ...others.slice(0, 8).map((o) => ({ domain: o.domain, name: o.domain.split('.')[0], isMe: false }))];
      return gbpSummary(d.maps?.rows, d.maps?.prevRows, doms, { now: d.maps?.day, prev: d.maps?.prevDay });
    } catch { return null; }
  })();
  const voiceNow = (d.industry || []).find((h) => h.day === report.day)?.voice || {};
  const voicePrev = [...(d.industry || [])].reverse().find((h) => h.day < report.day && h.voice && Object.keys(h.voice).length)?.voice || {};
  const sov = Object.keys(voiceNow).length ? (report.summary.board || []).filter((b) => voiceNow[b.domain] && voiceNow[b.domain].pairs).slice(0, 8).map((b) => { const v = voiceNow[b.domain], pv = voicePrev[b.domain]; const pc = (x) => Math.round((x.top3 / x.pairs) * 100); return { domain: b.domain, isMe: b.is_me, top3: pc(v), top10: Math.round((v.top10 / v.pairs) * 100), pairs: v.pairs, change: pv && pv.pairs ? pc(v) - pc(pv) : null }; }).sort((a, b) => b.top3 - a.top3 || b.top10 - a.top10) : [];
  const vitalsRows = [{ domain: project.domain, isMe: true, v: me.details?.profile?.vitals }, ...others.slice(0, 6).map((o) => ({ domain: o.domain, isMe: false, v: o.details?.profile?.vitals }))].filter((r) => r.v);
  const kv = report?.summary?.keywordVolumes && Object.keys(report.summary.keywordVolumes).length ? report.summary.keywordVolumes : null;
  const s = report.summary;
  const mine = s.board.find((b) => b.is_me);
  const leader = s.board[0];
  const plan = buildPlan(actions);
  const totalGain = Math.round(actions.reduce((a, x) => a + x.gain, 0) * 10) / 10;
  const potential = Math.min(100, Math.round((Number(me.overall) + totalGain) * 10) / 10);
  const byArea = (k) => actions.filter((a) => a.area === k);
  const hasProfiles = playbook.some((p) => p.hasProfile);
  const sourceOf = (dom) => d.comps.find((c) => c.domain === dom)?.source || 'discovered';
  const scoredList = [...others].sort((a, b) => b.overall - a.overall);
  const scoredSet = new Set(others.map((o) => o.domain));
  const waitingList = d.comps.filter((c) => c.status === 'active' && !scoredSet.has(c.domain)).slice(0, 30);
  const selRow = sel === 'all' ? null : others.find((o) => o.domain === sel) || null;

  const radarSeries = [
    { name: `${project.domain} (you)`, color: '#4f46e5', bold: true, values: { seo: me.seo, geo: me.geo, local: me.local, keywords: me.keywords } },
    ...playbook.slice(0, 3).map((p, i) => ({ name: p.domain, color: COLORS[i + 1], values: p.scores })),
  ];
  const days = [...new Set(hist.map((h) => h.day))].sort();
  const trendSeries = s.board.slice(0, 5).map((b, i) => ({ name: b.is_me ? `${b.domain} (you)` : b.domain, color: b.is_me ? '#4f46e5' : COLORS[i % COLORS.length], bold: b.is_me, points: Object.fromEntries(hist.filter((h) => h.domain === b.domain).map((h) => [h.day, Number(h.overall)])) }));

  function downloadCsv() {
    const head = ['Priority', 'Area', 'Action', 'Why it matters', 'How to fix', 'Effort', 'Current score', 'Best competitor', 'Estimated overall gain'];
    const lines = actions.map((a, i) => [i + 1, AREAS[a.area].label, a.title, a.why, a.how.join(' | '), EFFORT[a.effort], a.current, a.best ?? '', a.gain].map(csvCell).join(','));
    save(`${project.domain}-action-plan-${report.day}.csv`, [head.map(csvCell).join(','), ...lines].join('\n'), 'text/csv');
  }
  const withTargets = attachTargets(actions, me.details?.profile, keywordRows, project.locations);
  const gscIns = gscInsights(d.gsc.snap, project.keywords);
  const doneSet = new Set(d.fixLog.map((l) => l.check_name));
  const toggleDone = async (a) => { if (doneSet.has(a.check)) await undoDone(project.id, a.check); else await markDone(project.id, a, me, d.latestDay); const fresh = await loadProjectData(); if (fresh) setD(fresh); };
  const brief = (aiData) => buildBrief({ project, report, me, actions: withTargets, playbook, gaps, audit, keywordRows, ai: aiData ?? ai, gscIns, gscSnap: d.gsc.snap });
  async function downloadBrief() {
    // The brief is only specific to this business once the AI advice exists, so write it first if needed.
    let data = ai;
    if (!data) { setAiMsg('Writing advice for your business first, about 30 seconds…'); data = await generateAi(false); if (data) setAiMsg(''); }
    save(`${project.domain}-claude-brief-${report.day}.md`, brief(data), 'text/markdown');
  }
  const downloadJson = () => save(`${project.domain}-report-data-${report.day}.json`, JSON.stringify({ site: project.domain, date: report.day, scores: Object.fromEntries(Object.keys(AREAS).map((k) => [k, me[k]])), overall: me.overall, rank: s.myRank, leaderboard: s.board, actions, competitors: playbook, contentGaps: gaps, audit, keywords: keywordRows, ai }, null, 1), 'application/json');
  async function copyBrief() { let data = ai; if (!data) { setAiMsg('Writing advice for your business first…'); data = await generateAi(false); } await navigator.clipboard.writeText(brief(data)); setAiMsg('Brief copied. Paste it into Claude or any AI assistant.'); }

  let n = 0;
  const H = (t) => <h2>{++n}. {t}</h2>;

  return (
    <>
      <Nav right={nav} />
      <div className="wrap"><div className="report">
        <div className="page-head">
          <div>
            <div className="sub">Competitor Radar · Improvement report</div>
            <h1>{project.domain}</h1>
            <div className="sub">Prepared {report.day} · {project.keywords.length} keywords · {project.locations.join(', ')} · {s.total - 1} competitors</div>
          </div>
          <div className="no-print" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => window.print()}>Download PDF</button>
            <button className="ghost" onClick={downloadBrief}>AI brief (.md)</button>
            <button className="ghost" onClick={copyBrief}>Copy AI brief</button>
            <button className="ghost" onClick={downloadCsv}>Actions (CSV)</button>
            <button className="ghost" onClick={downloadJson}>All data (JSON)</button>
          </div>
        </div>
        {collecting && <div className="note no-print"><span className="spinner" style={{ width: 14, height: 14, marginRight: 8, verticalAlign: -2 }} />Collecting page-level detail about your site and top competitors. This takes 1 to 3 minutes and the report fills in as it finishes.</div>}
        {aiMsg && <div className="note no-print">{aiMsg}</div>}

        <div className="rep-sec">
          {H('Where you stand')}
          <div className="card pad hero">
            <ScoreRing value={Number(me.overall)} />
            <div className="hero-text">
              <div className="rank-big">#{s.myRank} of {s.total} <Change v={mine?.rankChange} /></div>
              <p className="sub" style={{ marginTop: 6 }}>
                {s.myRank === 1 ? `You lead the ${s.total - 1} competitors we compared. The actions below protect and extend that lead.` : `The leader, ${leader.domain}, scores ${leader.overall}. You score ${me.overall}, so you are ${Math.round((leader.overall - me.overall) * 10) / 10} points behind.`}
              </p>
              <p style={{ marginBottom: 0 }}>Completing the {actions.length} actions in this report could lift your score to about <b>{potential}</b>.</p>
            </div>
          </div>
          <div className="grid g2" style={{ marginTop: 16 }}>
            <div className="card pad"><h3>You against the top competitors</h3><Radar series={radarSeries} /></div>
            <div className="card pad"><h3>Overall score by site</h3><div style={{ height: 8 }} />
              <BarList items={s.board.slice(0, 10).map((b) => ({ label: b.domain + (b.is_me ? ' (you)' : ''), value: b.overall, highlight: b.is_me, color: b.is_me ? 'var(--accent)' : undefined }))} /></div>
          </div>
        </div>

        <div className="rep-sec">
          {H('Scorecard by area')}
          <div className="no-print" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            <label htmlFor="cmp" style={{ margin: 0 }}>Compare with</label>
            <select id="cmp" value={sel} onChange={(e) => setSel(e.target.value)} style={{ maxWidth: 420 }}>
              <option value="all">All competitors (best and average)</option>
              <optgroup label={`Scored competitors (${scoredList.length})`}>
                {scoredList.map((o) => <option key={o.domain} value={o.domain}>{o.domain} · {Math.round(o.overall)} · {sourceOf(o.domain) === 'manual' ? 'added by you' : 'found by AI'}</option>)}
              </optgroup>
              {waitingList.length > 0 && <optgroup label={`Waiting to be scored (${waitingList.length})`}>
                {waitingList.map((c) => <option key={c.domain} value="" disabled>{c.domain} · {c.source === 'manual' ? 'added by you' : 'found by AI'}</option>)}
              </optgroup>}
            </select>
          </div>
          <div className="card tbl-wrap"><table>
            <thead><tr><th>Area</th><th className="r">You</th>{selRow ? <><th className="r">{selRow.domain}</th><th className="r">Difference</th></> : <><th className="r">Best competitor</th><th className="r">Average</th></>}<th>Reading</th></tr></thead>
            <tbody>
              {[['overall', { label: 'Overall', blurb: 'Weighted score across all four areas.' }], ...Object.entries(AREAS)].map(([k, a]) => {
                const mineV = Number(me[k]);
                const themV = selRow ? Number(selRow[k]) : null;
                const diff = selRow ? Math.round((mineV - themV) * 10) / 10 : null;
                return (
                  <tr key={k} style={k === 'overall' ? { fontWeight: 600 } : undefined}>
                    <td><b>{a.label}</b><div className="sub" style={{ fontSize: 12, whiteSpace: 'normal', fontWeight: 400 }}>{a.blurb}</div></td>
                    <td className="r"><b style={{ color: tone(mineV) }}>{Math.round(mineV)}</b></td>
                    {selRow ? <><td className="r">{Math.round(themV)}</td><td className="r"><span className={diff > 0 ? 'up' : diff < 0 ? 'down' : 'muted'}>{diff > 0 ? '+' : ''}{diff}</span></td></> : <><td className="r">{k === 'overall' ? Math.round(Math.max(...others.map((o) => o.overall), 0)) : Math.round(best[k])}</td><td className="r">{k === 'overall' ? Math.round(others.reduce((x, o) => x + Number(o.overall), 0) / (others.length || 1)) : Math.round(avg[k])}</td></>}
                    <td style={{ whiteSpace: 'normal', minWidth: 200 }} className="sub">
                      {selRow ? (diff > 0 ? `You lead ${selRow.domain} by ${diff} points here.` : diff < 0 ? `${selRow.domain} leads you by ${Math.abs(diff)} points here.` : 'Level with this competitor.') : (k === 'overall' ? '' : sectorSummary(k, mineV, best[k], avg[k]))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
          {selRow && <p className="sub no-print" style={{ marginTop: 8 }}>{selRow.domain} is ranked #{(s.board.find((b) => b.domain === selRow.domain)?.rank) ?? '–'} and was {sourceOf(selRow.domain) === 'manual' ? 'added by you' : 'found by AI'}.</p>}
        </div>

        <div className="rep-sec">
          {H('Strategy summary')}
          {ai ? (
            <div className="card pad">
              <p>{ai.summary}</p>
              {ai.competitorMoves?.length > 0 && <><h3>What the leaders are doing</h3><ul className="howto">{ai.competitorMoves.map((m) => <li key={m.domain}><b>{m.domain}:</b> {m.insight}</li>)}</ul></>}
              <div className="no-print" style={{ marginTop: 10 }}><button className="ghost small" disabled={aiBusy} onClick={() => generateAi(true)}>{aiBusy ? 'Writing…' : 'Regenerate'}</button></div>
            </div>
          ) : (
            <div className="card pad no-print" style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}><h3>Get AI-written advice</h3><div className="sub">A plain-language strategy, content ideas to publish, and rewritten page titles and descriptions based on your data. Takes about 30 seconds.</div></div>
              <button disabled={aiBusy} onClick={() => generateAi(false)}>{aiBusy ? 'Writing…' : 'Generate AI insights'}</button>
            </div>
          )}
        </div>

        <div className="rep-sec">
          {H('Your biggest opportunities')}
          <div className="card pad">
            {actions.slice(0, 6).map((a, i) => <ActionRow key={a.check} a={a} i={i + 1} done={doneSet.has(a.check)} onToggle={toggleDone} />)}
            {!actions.length && <div className="empty">No major gaps found. Keep content fresh.</div>}
          </div>
        </div>


        {ind.benchmark && ind.findings.length > 0 && (
          <div className="rep-sec">
            {H('Technical findings, benchmarked against your market')}
            <p className="sub">Each finding compares your site with {ind.benchmark.sites} competitor{ind.benchmark.sites === 1 ? '' : 's'} in your market (top performers: {ind.benchmark.topSites.join(', ')}), using what we measured when we crawled them (up to 40 pages per site; server response time, not full browser load). The comparison is stored on every crawl, so the arrows show what moved since the last one.</p>
            {(() => { const t = ind.findings.map((f) => f.trend && f.trend.direction); const c = t.filter((x) => x === 'closing').length, w = t.filter((x) => x === 'widening').length;
              return (c || w) ? <div className="note" style={{ margin: '10px 0' }}>Since the previous crawl: {c} gap{c === 1 ? '' : 's'} closing, {w} widening.</div> : null; })()}
            {ind.findings.map((f) => (
              <div key={f.id} className="card pad" style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><h3 style={{ margin: 0 }}>{f.title}</h3><span className={'pill ' + (f.severity === 'high' ? 'bad' : f.severity === 'medium' ? 'warn' : 'neutral')}>{f.severity}</span><span className="pill neutral">{f.area === 'geo' ? 'AI visibility' : 'SEO'}</span></div>
                <p className="sub" style={{ margin: '8px 0' }}>{f.why}</p>
                {f.evidence.length > 0 && <div className="tbl-wrap"><table>
                  <thead><tr><th>Measurement</th><th className="r">You</th><th className="r">Top performers</th><th className="r">Market median</th></tr></thead>
                  <tbody>{f.evidence.map((e) => <tr key={e.label}><td style={{ whiteSpace: 'normal' }}>{e.label}</td><td className="r">{e.yours}</td><td className="r">{e.topPerformers}</td><td className="r">{e.market}{e.sites ? <span className="sub"> (n={e.sites})</span> : null}</td></tr>)}</tbody>
                </table></div>}
                {f.trend && <div className="sub" style={{ marginTop: 8, fontSize: 12.5 }}>
                  {f.trend.direction === 'closing' ? '▼ Gap closing' : f.trend.direction === 'widening' ? '▲ Gap widening' : '● Gap steady'} since {f.trend.sinceDay} ({f.trend.crawls} earlier crawl{f.trend.crawls === 1 ? '' : 's'}){f.trend.leadersMoved ? `; the top performers moved ${f.trend.leadersMoved > 0 ? '+' : ''}${f.trend.leadersMoved}` : ''}.
                </div>}
                <p style={{ margin: '10px 0 4px' }}><b>What to do:</b> {f.fix}</p>
                {f.pages && f.pages.length > 0 && <div className="sub" style={{ fontSize: 12.5 }}>Start with: {f.pages.map((p) => `${p.url} (${p.note})`).join(' · ')}</div>}
              </div>))}
          </div>
        )}

        {(sov.length > 0 || gbp || vitalsRows.length > 0) && (
          <div className="rep-sec">
            {H('Share of voice, Google Maps and Core Web Vitals')}
            {sov.length > 0 && <>
              <h3>Share of voice in Google results</h3>
              <p className="sub">Out of {sov[0].pairs} tracked searches (keyword and city), in how many each site is in Google's top 3 and top 10. Positions are refreshed weekly.</p>
              <div className="card tbl-wrap" style={{ marginBottom: 14 }}><table>
                <thead><tr><th>Site</th><th className="r">In top 3</th><th className="r">In top 10</th><th className="r">Change in top 3 since last check</th></tr></thead>
                <tbody>{sov.map((r) => <tr key={r.domain}><td>{r.domain}{r.isMe && <> <span className="pill neutral">you</span></>}</td><td className="r"><b>{r.top3}%</b></td><td className="r">{r.top10}%</td><td className="r">{r.change === null ? <span className="muted">–</span> : r.change === 0 ? '0' : `${r.change > 0 ? '+' : ''}${r.change} pts`}</td></tr>)}</tbody>
              </table></div></>}
            {gbp && <>
              <h3>Google Business Profile and Maps</h3>
              <p className="sub">Read from Google Maps on {gbp.day}{gbp.prevDay ? `, compared with ${gbp.prevDay}` : ''}. Rating, reviews, category and Maps position are what Google shows publicly; reply rate and review topics are not available to us.</p>
              <div className="card tbl-wrap" style={{ marginBottom: 14 }}><table>
                <thead><tr><th>Business</th><th className="r">Rating</th><th className="r">Reviews</th><th className="r">New reviews / week</th><th className="r">In Maps top 3</th><th>Category</th></tr></thead>
                <tbody>{[gbp.me, ...gbp.others].filter(Boolean).map((r) => <tr key={r.domain}><td style={{ whiteSpace: 'normal' }}>{r.name || r.domain}{r.isMe && <> <span className="pill neutral">you</span></>}<div className="sub" style={{ fontSize: 12 }}>{r.domain}</div></td>
                  <td className="r">{r.found && r.rating != null ? r.rating : <span className="muted">{r.found ? '–' : 'not found'}</span>}</td><td className="r">{r.reviews ?? <span className="muted">–</span>}</td><td className="r">{r.reviewsPerWeek ?? <span className="muted">–</span>}</td>
                  <td className="r">{r.pairs ? `${r.top3} of ${r.pairs}` : '–'}</td><td className="sub">{r.category || ''}</td></tr>)}</tbody>
              </table></div>
              {gbp.findings.map((f) => <div key={f.id} className="card pad" style={{ marginBottom: 10 }}><div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><h4 style={{ margin: 0 }}>{f.title}</h4><span className={'pill ' + (f.severity === 'high' ? 'bad' : f.severity === 'medium' ? 'warn' : 'neutral')}>{f.severity}</span></div><p className="sub" style={{ margin: '6px 0' }}>{f.why}</p><p style={{ margin: 0 }}><b>What to do:</b> {f.fix}</p></div>)}</>}
            {vitalsRows.length > 0 && <>
              <h3>Core Web Vitals (home page, mobile)</h3>
              <p className="sub">Google's thresholds for a good experience: LCP up to 2.5 s, CLS up to 0.1, INP up to 200 ms. "Real users" figures come from Chrome's field data when the site has enough visits; otherwise a lab test is shown.</p>
              <div className="card tbl-wrap" style={{ marginBottom: 14 }}><table>
                <thead><tr><th>Site</th><th className="r">LCP</th><th className="r">CLS</th><th className="r">INP</th><th>Source</th></tr></thead>
                <tbody>{vitalsRows.map((r) => { const cell = (v, fmtv, rating) => v == null ? <span className="muted">–</span> : <span className={'pill ' + (rating === 'good' ? 'good' : rating === 'poor' ? 'bad' : 'warn')}>{fmtv(v)}</span>; return <tr key={r.domain}><td>{r.domain}{r.isMe && <> <span className="pill neutral">you</span></>}</td>
                  <td className="r">{cell(r.v.lcp, (v) => (v / 1000).toFixed(1) + ' s', r.v.rating?.lcp)}</td><td className="r">{cell(r.v.cls, (v) => v.toFixed(2), r.v.rating?.cls)}</td><td className="r">{cell(r.v.inp, (v) => Math.round(v) + ' ms', r.v.rating?.inp)}</td><td className="sub">{r.v.source}</td></tr>; })}</tbody>
              </table></div></>}
          </div>
        )}
        <div className="rep-sec">
          {H('What your top competitors are doing')}
          {!hasProfiles && <div className="note">Detailed competitor profiles appear after the next daily run. Click "Find new competitors" on the dashboard to collect them now. Until then this section uses score differences only.</div>}
          {playbook.map((c) => (
            <div className="card pad" key={c.domain} style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div><h3 style={{ fontSize: 17 }}>{c.domain}</h3>
                  <div className="tags" style={{ marginTop: 2 }}>{Object.entries(AREAS).map(([k, a]) => <span key={k} className={'pill ' + (c.scores[k] > Math.round(me[k]) ? 'bad' : 'good')}>{a.label}: {c.scores[k]} vs your {Math.round(me[k])}</span>)}</div></div>
                <div className="sector-score" style={{ color: tone(c.overall) }}>{Math.round(c.overall)}</div>
              </div>
              {c.facts && <p className="sub" style={{ margin: '10px 0 0' }}>{c.facts.pages} pages read · {c.facts.sitemapUrls} in sitemap · {c.facts.avgWords} words per page · {c.facts.faqPages} FAQ pages · {c.facts.schemaTypes.length} schema types{c.facts.llmsTxt ? ' · has llms.txt' : ''}</p>}
              {c.tips.length > 0 && <><h3 style={{ marginTop: 12 }}>What to learn from them</h3><ul className="howto">{c.tips.map((t) => <li key={t}>{t}</li>)}</ul></>}
              {c.topPages.length > 0 && <><h3 style={{ marginTop: 12 }}>Their key pages</h3><ul className="howto">{c.topPages.map((p) => <li key={p.url}>{p.title || p.url} <span className="muted">({p.words} words)</span></li>)}</ul></>}
              {!c.tips.length && !c.topPages.length && <p className="sub" style={{ marginTop: 10 }}>No clear advantages over you in the data collected so far.</p>}
            </div>
          ))}
        </div>

        <div className="rep-sec">
          {H('Content to create')}
          {gaps.length > 0 && <div className="card pad" style={{ marginBottom: 14 }}><h3>Topics competitors cover that you do not</h3><div className="sub" style={{ marginBottom: 6 }}>Phrases that appear in titles or headings on at least two competitor sites but never on yours.</div>
            <ul className="howto">{gaps.map((g) => <li key={g.phrase}><b>{g.phrase}</b> <span className="muted">· {g.competitors.join(', ')}</span></li>)}</ul></div>}
          {ai?.contentIdeas?.length > 0 && <div className="card pad"><h3>Pages and articles to publish</h3>
            {ai.contentIdeas.map((c, i) => <div className="action" key={c.title}><span className="num">{i + 1}</span><div><h3>{c.title}</h3><div className="sub">{c.outline}</div><div className="tags"><span className="pill neutral">Targets: {c.keyword}</span></div></div></div>)}</div>}
          {!gaps.length && !ai?.contentIdeas?.length && <div className="card pad sub">Generate the AI insights above to get a list of content ideas, or wait for competitor profiles from the next run.</div>}
        </div>

        {Object.entries(AREAS).map(([k, a]) => (
          <div className="rep-sec" key={k}>
            {H(`${a.label}: ideas and solutions`)}
            <p className="sub">{a.blurb} You score <b style={{ color: tone(me[k]) }}>{Math.round(me[k])}</b>; the best competitor scores {Math.round(best[k])}.</p>
            <div className="card pad">
              {byArea(k).map((x) => withTargets.find((w) => w.check === x.check) || x).map((x, i) => <ActionRow key={x.check} a={x} i={i + 1} full done={doneSet.has(x.check)} onToggle={toggleDone} />)}
              {!byArea(k).length && <div className="empty">Nothing urgent here. You are strong in this area.</div>}
            </div>
          </div>
        ))}

        <div className="rep-sec">
          {H('Keyword opportunities')}
          <p className="sub">Who owns each search today, and how well your site targets it.</p>
          <div className="card pad" style={{ marginBottom: 14 }}>
            <h3>Your page coverage by keyword</h3><div style={{ height: 6 }} />
            <BarList items={keywordRows.map((r) => ({ label: r.keyword, value: r.coverage, color: tone(r.coverage), note: `${r.coverage}%` + (r.mineBest ? ` · Google #${r.mineBest}` : ' · not in top 10') }))} />
          </div>
          <div className="card tbl-wrap"><table>
            <thead><tr><th>Keyword</th><th className="r">Coverage</th>{kv && <th className="r" title="Monthly Google searches in India (Google Keyword Planner data via Keywords Everywhere)">Searches / month</th>}<th className="r">Your position</th>{gscIns && <th className="r">Real position (Google)</th>}<th>Ranking above you</th></tr></thead>
            <tbody>{keywordRows.map((r) => (
              <tr key={r.keyword}><td style={{ whiteSpace: 'normal', minWidth: 180 }}>{r.keyword}</td><td className="r">{r.coverage}%</td>
                {kv && <td className="r">{kv[r.keyword.toLowerCase()]?.volume == null ? <span className="muted">–</span> : kv[r.keyword.toLowerCase()].volume.toLocaleString('en-IN')}</td>}
                <td className="r">{r.mineBest ? `#${r.mineBest}` : <span className="muted">not in top 10</span>}</td>
                {gscIns && <td className="r">{gscIns.realRank[r.keyword] ? `${gscIns.realRank[r.keyword].position} · ${gscIns.realRank[r.keyword].impressions} views` : <span className="muted">no data</span>}</td>}
                <td style={{ whiteSpace: 'normal' }} className="sub">{r.top.length ? r.top.map(([dom, p]) => `${dom} (#${p})`).join(', ') : 'No clear leader'}</td></tr>))}</tbody>
          </table></div>
        </div>

        {gscIns && (
          <div className="rep-sec">
            {H('Real search performance (Google Search Console)')}
            <p className="sub">{d.gsc.snap.range.start} to {d.gsc.snap.range.end}: {d.gsc.snap.totals.clicks} clicks, {d.gsc.snap.totals.impressions} impressions, average position {d.gsc.snap.totals.position}.</p>
            {[['Close to page one (positions 8 to 20)', gscIns.strike], ['Ranking in the top 10 but rarely clicked', gscIns.lowCtr]].map(([t, rows]) => rows.length > 0 && (
              <div className="card tbl-wrap" key={t} style={{ marginBottom: 14 }}><div style={{ padding: '14px 16px 0' }}><h3>{t}</h3></div><table>
                <thead><tr><th>Search</th><th className="r">Position</th><th className="r">Impressions</th><th className="r">Clicks</th></tr></thead>
                <tbody>{rows.map((r) => <tr key={r.query}><td style={{ whiteSpace: 'normal' }}>{r.query}</td><td className="r">{r.position}</td><td className="r">{r.impressions}</td><td className="r">{r.clicks}</td></tr>)}</tbody></table></div>))}
          </div>
        )}

        {ai?.rewrites?.length > 0 && (
          <div className="rep-sec">
            {H('Rewritten titles and descriptions')}
            <div className="card pad">{ai.rewrites.map((r) => (
              <div className="action" key={r.url}><div style={{ minWidth: 0 }}><div className="sub" style={{ fontSize: 12, wordBreak: 'break-all' }}>{r.url}</div><h3>{r.title}</h3><div className="sub">{r.description}</div></div></div>))}</div>
          </div>
        )}

        <div className="rep-sec">
          {H('Technical SEO audit')}
          {!audit ? <div className="note">The technical audit appears after your next daily run, or click "Find new competitors" on the dashboard to collect it now.</div> : (
            <>
              <div className="grid g4" style={{ marginBottom: 14 }}>
                {[['Pages read', audit.totals.pages], ['In sitemap', audit.totals.sitemap], ['Avg words', audit.totals.avgWords], ['FAQ pages', audit.totals.faqPages]].map(([l, v]) => <div key={l} className="card sector"><div className="sub">{l}</div><div className="sector-score">{v}</div></div>)}
              </div>
              <div className="card pad" style={{ marginBottom: 14 }}>
                <h3>Issues found</h3>
                {audit.issues.length ? audit.issues.map((it) => (
                  <div className="action" key={it.id}><div style={{ minWidth: 0 }}><h3>{it.label}: {it.count}</h3><div className="sub" style={{ fontSize: 12.5, wordBreak: 'break-all' }}>{it.examples.join(' · ')}</div></div></div>)) : <div className="empty">No page-level issues found.</div>}
                {audit.duplicateTitles.length > 0 && <div className="action"><div><h3>Duplicate titles: {audit.duplicateTitles.length}</h3><div className="sub" style={{ fontSize: 12.5 }}>{audit.duplicateTitles.map((x) => `"${x.title}" on ${x.urls.length} pages`).join(' · ')}</div></div></div>}
                <div className="sub" style={{ marginTop: 10, fontSize: 12.5 }}>Structured data found: {audit.totals.schemaTypes.join(', ') || 'none'} · llms.txt: {audit.totals.llmsTxt ? 'yes' : 'no'} · robots.txt: {audit.totals.robotsTxt ? 'yes' : 'no'}</div>
              </div>
              <div className="card tbl-wrap"><table>
                <thead><tr><th>Page</th><th className="r">Title len</th><th className="r">Meta len</th><th className="r">H1</th><th className="r">Words</th><th className="r">Inlinks</th><th className="r">Ms</th></tr></thead>
                <tbody>{audit.pages.map((p) => (
                  <tr key={p.url}><td style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }} title={p.url}>{p.url.replace(/^https?:\/\/(www\.)?[^/]+/, '') || '/'}</td>
                    <td className="r" style={{ color: !p.title || p.title.length > 65 || p.title.length < 30 ? 'var(--bad)' : undefined }}>{p.title.length}</td>
                    <td className="r" style={{ color: !p.descLen || p.descLen < 70 || p.descLen > 160 ? 'var(--bad)' : undefined }}>{p.descLen}</td>
                    <td className="r" style={{ color: p.h1.length !== 1 ? 'var(--bad)' : undefined }}>{p.h1.length}</td>
                    <td className="r" style={{ color: p.words < 300 ? 'var(--warn)' : undefined }}>{p.words}</td><td className="r">{p.inlinks}</td><td className="r">{p.ms}</td></tr>))}</tbody>
              </table></div>
            </>
          )}
        </div>

        <div className="rep-sec">
          {H('Your 30-day plan')}
          {plan.map((items, w) => items.length > 0 && (
            <div className="week" key={w}>
              <h3>Week {w + 1}{w === 0 ? ' · Quick wins' : w === 3 ? ' · Bigger builds' : ''}</h3>
              <ul className="howto">{items.map((a) => <li key={a.check}><b>{a.title}</b> <span className="muted">({AREAS[a.area].label}, +{a.gain} pts)</span></li>)}</ul>
            </div>))}
        </div>

        <div className="rep-sec">
          {H('Competitor snapshot and trend')}
          <div className="card tbl-wrap" style={{ marginBottom: 14 }}><table>
            <thead><tr><th>#</th><th>Site</th><th className="r">Overall</th><th className="r">SEO</th><th className="r">AI</th><th className="r">Local</th><th className="r">Keywords</th></tr></thead>
            <tbody>{s.board.map((r) => <tr key={r.domain} className={r.is_me ? 'me' : ''}><td>{r.rank}</td><td>{r.domain}{r.is_me ? ' (you)' : ''}</td><td className="r"><b>{r.overall}</b></td><td className="r">{Math.round(r.seo)}</td><td className="r">{Math.round(r.geo)}</td><td className="r">{Math.round(r.local)}</td><td className="r">{Math.round(r.keywords)}</td></tr>)}</tbody>
          </table></div>
          {days.length > 1 ? <div className="card pad"><h3>Score over time</h3><Trend series={trendSeries} days={days} /></div> : <div className="sub">The trend chart appears after your second daily report.</div>}
        </div>

        <div className="card pad no-print" style={{ marginBottom: 20 }}>
          <h3>Use this report with an AI assistant</h3>
          <div className="sub">Download "AI brief (.md)" and paste it into Claude or any AI assistant. It works for any website platform. If the assistant can reach your site (a CMS or builder such as WordPress, Shopify, Wix or Webflow, a code repository, or a browser session) it makes the changes. If not, it writes a copy-and-paste change sheet for you or your developer. The brief lists each task, the exact pages and current values, competitor benchmarks and what done looks like. Review before publishing.</div>
        </div>

        <p className="sub" style={{ fontSize: 12 }}>
          How scores work: each site's public pages are crawled and scored 0 to 100 in four areas, then combined (SEO 30%, AI visibility 25%, Local 20%, Keywords 25%). Competitors are discovered from Google results, Google Maps and well-known names in your industry. Backlink and domain-authority data are not included. Estimated gains are indicative. Report generated {report.day}.
        </p>
      </div></div>
    </>
  );
}

function ActionRow({ a, i, full, done, onToggle }) {
  return (
    <div className="action">
      <span className="num">{i}</span>
      <div style={{ minWidth: 0 }}>
        <h3>{a.title}</h3>
        <div className="sub" style={{ marginBottom: 4 }}>{a.why}</div>
        {full && <ul className="howto">{a.how.map((h) => <li key={h}>{h}</li>)}</ul>}
        {full && a.targets?.length > 0 && <details style={{ marginTop: 6 }}><summary className="sub" style={{ cursor: 'pointer' }}>Pages to change ({a.targets.length})</summary><ul className="howto">{a.targets.map((t, i) => <li key={i} style={{ wordBreak: 'break-all' }}>{t.keyword ? `"${t.keyword}": ${t.url || 'no page yet'}` : `${t.url.replace(/^https?:\/\/(www\.)?[^/]+/, '') || '/'} · ${t.words} words`}</li>)}</ul></details>}
        <div className="tags">
          <span className="pill neutral">{AREAS[a.area].label}</span>
          <span className="pill good">+{a.gain} pts overall</span>
          <span className="pill warn">{EFFORT[a.effort]}</span>
          <span className="pill neutral">You {a.current}{a.best != null ? ` · best competitor ${a.best}` : ''}</span>
          {done && <span className="pill good">Marked done</span>}
          <button className="ghost small no-print" onClick={() => onToggle(a)}>{done ? 'Undo' : 'Mark done'}</button>
        </div>
      </div>
    </div>
  );
}
