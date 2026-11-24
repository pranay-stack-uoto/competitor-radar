'use client';
import { useEffect, useRef, useState } from 'react';
import { DataHealth } from '../datahealth';
import { etaText } from '@/lib/progress';
import Link from 'next/link';
import { sb } from '@/lib/supabase-browser';
import { loadProjectData } from '@/lib/data';
import { AREAS, EFFORT } from '@/lib/recommendations';
import { Nav, ScoreRing, Change, AnimatedNumber } from '../components';
import { Tiles, ChartCard, RadarCard, Leaderboard } from '../overview';
import { ChangesPanel, FixesPanel, SearchPanel, AuditPanel } from '../panels';
import { markDone } from '@/lib/fixes';

export default function Dashboard() {
  const [d, setD] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [crawling, setCrawling] = useState(false);
  const [plan, setPlan] = useState(null);
  const [progress, setProgress] = useState(null);
  const [notice, setNotice] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [sel, setSel] = useState('overall');

  // Re-render only when the data actually changed, and poll only while something is still being worked on.
  const sig = useRef('');
  const busy = useRef(true);
  async function load() {
    const r = await loadProjectData();
    if (!r) return;
    const next = JSON.stringify([r.project.keywords, r.project.locations, r.project.summary, r.latestDay, r.report?.summary?.board?.map((b) => [b.domain, b.overall, b.rank]), r.report?.summary?.ai?.generatedAt, r.comps.map((c) => [c.id, c.status, c.source]), r.hist.length, r.fixLog.map((f) => f.check_name), r.audit?.day, r.audit?.pages, r.gsc?.day, r.gsc?.conn?.status, r.gsc?.conn?.site_url]);
    const scored = new Set((r.scores || []).map((x) => x.domain));
    busy.current = !r.report || r.comps.some((c) => c.status === 'active' && c.source === 'manual' && !scored.has(c.domain));
    if (next !== sig.current) { sig.current = next; setD(r); }
  }
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible' && busy.current) load(); }, 20000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { if (d?.project?.id) nudge(); }, [d?.project?.id]);
  useEffect(() => {
    if (!d?.project?.organisation_id) return;
    sb().from('organisations').select('plan,trial_runs_limit,trial_runs_used,trial_ends_at,plan_until').eq('id', d.project.organisation_id).maybeSingle().then(({ data }) => setPlan(data || null));
  }, [d?.project?.organisation_id, d?.latestDay]);

  async function setStatus(id, status) { await sb().from('competitors').update(status === 'active' ? { status, source: 'manual' } : { status }).eq('id', id); load(); }
  async function addManual() {
    const v = prompt('Competitor website (for example example.com)'); if (!v) return;
    const t = (await sb().auth.getSession()).data.session?.access_token;
    const r = await fetch('/api/competitor/add', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: JSON.stringify({ projectId: d.project.id, site: v }) });
    const j = await r.json();
    setNotice(r.ok ? `Added ${j.domain}. It is being scored now and will join the leaderboard in about 2 to 5 minutes. Keep this page open.` : (j.error || 'Could not add that site.'));
    load(); if (r.ok) nudge();
  }
  async function refreshCompetitors() {
    setRefreshing(true); setNotice('');
    const t = (await sb().auth.getSession()).data.session?.access_token;
    const r = await fetch('/api/project/start', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: JSON.stringify({ projectId: d.project.id, full: true }) });
    const j = await r.json();
    setNotice(j.queued ? 'Searching for new competitors. New names appear below in a few minutes, and your report updates when scoring finishes.' : (j.message || j.error || 'Could not start a search.'));
    setRefreshing(false); load(); if (j.queued) nudge();
  }
  // The "Crawl now" button: re-reads every tracked site and rebuilds today's report. Always works the queue too, so jobs left over from a missed
  // background run are finished by this click.
  async function crawlNow() {
    setCrawling(true); setNotice(''); setProgress({ phase: 'starting', percent: 3, etaSeconds: null });
    const since = new Date().toISOString();
    const t = (await sb().auth.getSession()).data.session?.access_token;
    const r = await fetch('/api/project/start', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: JSON.stringify({ projectId: d.project.id, recrawl: true }) });
    const j = await r.json().catch(() => ({}));
    if (!(j.queued || j.busy)) { setNotice(j.message || j.error || 'Could not start a crawl.'); setProgress(null); setCrawling(false); return; }
    setNotice('Crawling now. Keep this page open: scores and your report update here when it finishes.');
    // The meter: ask for the refresh's progress every 5 seconds while the queue is being worked (nudge below does the work).
    let polling = true;
    const poll = async () => {
      while (polling) {
        const tok = (await sb().auth.getSession()).data.session?.access_token;
        const pr = await fetch('/api/project/progress', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify({ projectId: d.project.id, since }) }).then((x) => x.json()).catch(() => null);
        if (pr && pr.phase) setProgress(pr);
        await new Promise((res) => setTimeout(res, 5000));
      }
    };
    poll();
    await load(); await nudge();
    polling = false;
    setProgress({ phase: 'done', percent: 100, etaSeconds: 0 }); await load();
    setNotice('Done. Your scores and report are up to date.');
    setTimeout(() => setProgress(null), 4000);
    setCrawling(false);
  }
  async function nudge() {
    // Works the queue and publishes the leaderboard; repeats while anything is still being scored.
    for (let i = 0; i < 20; i++) {
      const t = (await sb().auth.getSession()).data.session?.access_token;
      if (!t || !d?.project?.id) return;
      const r = await fetch('/api/project/nudge', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: JSON.stringify({ projectId: d.project.id }) });
      const j = await r.json().catch(() => ({}));
      await load();
      if (!j.pending) return;
    }
  }
  async function done(a) { await markDone(d.project.id, a, d.me, d.latestDay); load(); }
  async function recheck() {
    setRechecking(true);
    for (let i = 0; i < 20; i++) {
      const t = (await sb().auth.getSession()).data.session?.access_token;
      const r = await fetch('/api/project/nudge', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: JSON.stringify({ projectId: d.project.id, recheck: i === 0 }) });
      const j = await r.json().catch(() => ({}));
      if (!j.pending) break;
    }
    await load(); setRechecking(false);
  }
  async function signOut() { await sb().auth.signOut(); window.location.href = '/login'; }

  const nav = <><button className="small no-print" onClick={crawlNow} disabled={crawling}>{crawling ? 'Crawling…' : 'Crawl now'}</button><Link className="btn ghost small no-print" href="/report">Full report</Link><button className="ghost small" onClick={signOut}>Sign out</button></>;
  if (!d) return <><Nav right={nav} /><div className="wrap"><div className="skeleton" style={{ height: 40, width: 260, marginBottom: 24 }} /><div className="grid g4">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 130 }} />)}</div></div></>;

  const { project, report, comps, hist, me, others, actions, best, avg } = d;
  const s = report?.summary;
  const mine = s?.board.find((b) => b.is_me);
  const leader = s?.board?.[0];
  const doneSet = new Set(d.fixLog.map((l) => l.check_name));
  const scoredSet = new Set((d.scores || []).map((x) => x.domain));
  const tracked = comps.filter((c) => c.status === 'active' && (c.source === 'manual' || scoredSet.has(c.domain)));
  const waiting = comps.filter((c) => c.status === 'active' && !tracked.includes(c));
  const ranked = Object.fromEntries([...(s?.board || [])].sort((a, b) => Number(b.overall) - Number(a.overall)).map((b, i) => [b.domain, { ...b, rank: i + 1 }]));

  return (
    <>
      <Nav right={nav} />
      <div className="wrap">
        {plan?.plan === 'trial' && (() => {
          const left = Math.max(0, plan.trial_runs_limit - plan.trial_runs_used), days = Math.max(0, Math.ceil((new Date(plan.trial_ends_at) - Date.now()) / 86400000));
          const over = !left || !days;
          return <div className="note" style={{ marginBottom: 14 }}>{over ? 'Your free trial has ended. Your data and reports stay available, but new crawls are paused. Contact us to continue.' : `Free trial: ${left} of ${plan.trial_runs_limit} updates left, ${days} day${days === 1 ? '' : 's'} to go. Each daily update and each "Crawl now" uses one.`}</div>;
        })()}
        {progress && (
          <div className="card pad" style={{ marginBottom: 14 }} role="status" aria-live="polite">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
              <b>{progress.phase === 'done' ? 'Finished' : progress.phase === 'searching' ? 'Checking Google and Maps…' : progress.phase === 'starting' ? 'Starting…' : `Crawling ${progress.done ?? 0} of ${progress.total ?? 0} sites…`}</b>
              <span className="sub">{progress.percent}%{progress.phase !== 'done' && etaText(progress.etaSeconds) ? ' · ' + etaText(progress.etaSeconds) : ''}</span>
            </div>
            <div style={{ height: 8, borderRadius: 4, background: 'var(--line)', overflow: 'hidden' }}><div style={{ height: '100%', width: progress.percent + '%', background: 'var(--accent, #7c83ff)', transition: 'width .6s ease' }} /></div>
          </div>)}
        {s?.coverage?.partial && <div className="note" style={{ marginBottom: 14 }}>Partial update: {s.coverage.scored} of {s.coverage.planned} sites are scored so far. The rest are added as they finish, usually within an hour, and the ranking updates then.</div>}
        {report && Math.floor((Date.now() - new Date(report.day).getTime()) / 86400000) >= 2 && <div className="err" style={{ marginBottom: 14 }}>The last update was on {report.day}. Today's update has not completed yet. If this stays for more than a few hours, click "Crawl now".</div>}
        <div className="page-head rise">
          <div>
            <h1>{project.name === project.domain ? project.domain : project.name}</h1>
            <div className="sub">{project.domain} · {project.keywords.length} keywords · {project.locations.join(', ') || 'no locations'}</div>
          </div>
          <DataHealth projectId={project.id} refreshKey={d.latestDay + String(crawling)} gscConnected={d.gsc?.conn?.status === 'ok'} positionsDate={project.serp_searched_on} />
        </div>

        {!s ? (
          <div className="card pad rise" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <span className="spinner" />
            <div><h2>Building your first report</h2><div className="sub">We are searching Google for your keywords, finding who ranks, and scoring each site. This usually takes 5 to 15 minutes, and this page updates by itself.</div>
              {comps.filter((c) => c.status === 'active').length > 0 && <div className="sub" style={{ marginTop: 8 }}>Competitors found so far: {comps.filter((c) => c.status === 'active').slice(0, 6).map((c) => c.domain).join(', ')}</div>}</div>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'minmax(0, 1fr)' }}>
            <div className="card pad hero rise">
              <ScoreRing value={Number(mine?.overall || 0)} size={112} color="var(--c-overall)" />
              <div className="hero-text">
                <div className="sub">Your position among {s.total} sites</div>
                <div className="rank-big">#<AnimatedNumber value={s.myRank} /> <span style={{ fontSize: 15, fontWeight: 500 }} className="sub">of {s.total}</span> <span style={{ fontSize: 14 }}><Change v={mine?.rankChange} /></span></div>
                <p className="sub" style={{ margin: '6px 0 10px' }}>
                  {s.myRank === 1 ? 'You lead your market. Keep widening the gap.' : <>Leader: <b>{leader.domain}</b> at {leader.overall}. You are {Math.round((leader.overall - mine.overall) * 10) / 10} points behind.</>}
                  {s.newCompetitors.length > 0 && <> New today: <b>{s.newCompetitors.join(', ')}</b>.</>}
                </p>
                <Link href="/report" className="btn small no-print">Get your improvement report</Link>
              </div>
            </div>

            <Tiles project={project} board={s.board} hist={hist} sel={sel} setSel={setSel} />

            <div className="grid g21">
              <ChartCard project={project} board={s.board} hist={hist} sel={sel} />
              <RadarCard project={project} board={s.board} me={mine} />
            </div>

            <SearchPanel d={d} reload={load} />

            <Leaderboard board={s.board} sel={sel} setSel={setSel} />

            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
              <ChangesPanel summary={s} />
              <div className="stack">
                <div className="card pad rise" style={{ '--i': 8 }}>
                  <h2>Fix these first</h2>
                  <div className="sub" style={{ marginBottom: 4 }}>Highest score gain for the least effort</div>
                  {actions.filter((a) => !doneSet.has(a.check)).slice(0, 5).map((a, i) => (
                    <div className="action" key={a.check}>
                      <span className="num">{i + 1}</span>
                      <div style={{ minWidth: 0 }}><h3>{a.title}</h3>
                        <div className="tags"><span className="pill neutral">{AREAS[a.area].label}</span><span className="pill good">+{a.gain} pts</span><span className="pill warn">{EFFORT[a.effort]}</span></div></div>
                      <button className="ghost small no-print" style={{ marginLeft: 'auto', alignSelf: 'flex-start' }} onClick={() => done(a)}>Mark done</button>
                    </div>))}
                  {!actions.length && <div className="empty">No major gaps found.</div>}
                  <Link href="/report" className="btn ghost small no-print" style={{ marginTop: 10 }}>See all {actions.filter((a) => !doneSet.has(a.check)).length} actions</Link>
                </div>
              </div>
            </div>

            {d.fixLog.length > 0 && <FixesPanel d={d} reload={load} recheck={recheck} rechecking={rechecking} />}

            <AuditPanel d={d} reload={load} />
          </div>
        )}

        <div className="card rise" style={{ marginTop: 14, '--i': 9 }}>
          <div className="card-head">
            <div><h2>Competitors we track</h2><div className="sub">Found from Google results, Google Maps and well-known names in your industry</div></div>
            <div className="no-print" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="small" onClick={refreshCompetitors} disabled={refreshing}>{refreshing ? 'Starting…' : 'Find new competitors'}</button>
              <button className="ghost small" onClick={addManual}>+ Add one manually</button>
            </div>
          </div>
          {notice && <div className="note" style={{ margin: '12px 20px 0' }}>{notice}</div>}
          <div className="tbl-wrap"><table>
            <thead><tr><th>Competitor</th><th>Source</th><th className="r">Overall score</th><th className="r">Rank</th><th className="r">Seen in searches</th><th className="r no-print"></th></tr></thead>
            <tbody>{tracked.map((c) => (
              <tr key={c.id}>
                <td><a className="sitelink" href={'https://' + c.domain} target="_blank" rel="noopener noreferrer" title={`Open ${c.domain} in a new tab`}><b>{c.name && c.name !== c.domain ? c.name : c.domain}</b><svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M4.5 2H2.5A1 1 0 0 0 1.5 3v6.5a1 1 0 0 0 1 1H9a1 1 0 0 0 1-1v-2M7 1.5h3.5V5M10.5 1.5 5.5 6.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg></a>{c.name && c.name !== c.domain && <div className="sub" style={{ fontSize: 12 }}>{c.domain}</div>}</td>
                <td><span className={'pill ' + (c.source === 'manual' ? 'neutral' : 'good')}>{c.source === 'manual' ? 'added by you' : 'found by bot'}</span></td>
                <td className="r">{ranked[c.domain] ? <b>{Math.round(Number(ranked[c.domain].overall) * 10) / 10}</b> : <span className="muted">Scoring…</span>}</td>
                <td className="r">{ranked[c.domain] ? `#${ranked[c.domain].rank} of ${s.total}` : <span className="muted">–</span>}</td>
                <td className="r">{c.source === 'manual' && !c.appearances ? <span className="muted">–</span> : c.appearances}</td>
                <td className="r no-print"><button className="ghost small" onClick={() => setStatus(c.id, 'ignored')}>Not a competitor</button></td>
              </tr>))}
              {!tracked.length && <tr><td colSpan="6" className="empty">Nothing yet.</td></tr>}
            </tbody>
          </table></div>
          {waiting.length > 0 && <div className="sub no-print" style={{ padding: '10px 20px', borderTop: '1px solid var(--line)' }}>{waiting.length} more candidates were found by the search bot. They are scored only if they rank in the top 10 by search strength (competitors you add yourself are always scored): {waiting.slice(0, 8).map((c) => c.domain).join(', ')}{waiting.length > 8 ? '…' : ''}</div>}
          {comps.some((c) => c.status === 'ignored') && (
            <div className="no-print" style={{ padding: '12px 20px', borderTop: '1px solid var(--line)' }}>
              <button className="ghost small" onClick={() => setShowHidden(!showHidden)}>{showHidden ? 'Hide' : 'Show'} {comps.filter((c) => c.status === 'ignored').length} removed sites</button>
              {showHidden && <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>{comps.filter((c) => c.status === 'ignored').map((c) => <span key={c.id} className="chip" onClick={() => setStatus(c.id, 'active')} title="Click to track again">{c.domain} ↺</span>)}</div>}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
