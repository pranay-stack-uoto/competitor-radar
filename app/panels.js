'use client';
import { useEffect, useState } from 'react';
import { sb } from '@/lib/supabase-browser';
import { AREAS } from '@/lib/recommendations';
import { effectOf, STATUS_TEXT, undoDone } from '@/lib/fixes';
import { gscInsights, matchesTracked } from '@/lib/gscView';

const token = async () => (await sb().auth.getSession()).data.session?.access_token;
const post = async (url, body) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` }, body: JSON.stringify(body) }); return { ok: r.ok, ...(await r.json().catch(() => ({}))) }; };
const nf = (n) => Number(n).toLocaleString('en-IN');

// What moved since the previous daily report, for you and for each competitor.
export function ChangesPanel({ summary }) {
  const list = summary?.changes || [];
  return (
    <div className="card pad">
      <h2>What changed</h2>
      <div className="sub" style={{ marginBottom: 6 }}>{summary?.changesSince ? `Since ${summary.changesSince}` : 'Changes appear after your second daily report'}</div>
      {summary?.changesSince && !list.length && <div className="sub">Nothing moved much. That is normal day to day.</div>}
      {list.map((c, i) => (
        <div className="action" key={i}>
          <span className={'pill ' + (c.kind === 'gain' ? 'good' : c.kind === 'loss' ? 'bad' : 'neutral')} style={{ alignSelf: 'flex-start' }}>{c.kind === 'gain' ? '▲' : c.kind === 'loss' ? '▼' : '•'}</span>
          <div style={{ minWidth: 0 }}>
            <div><b>{c.is_me ? 'You' : c.domain}</b> <span className="sub">{c.text}</span></div>
            {c.lesson && <div className="sub" style={{ marginTop: 3 }}><b>Worth copying:</b> {c.lesson}</div>}
          </div>
        </div>))}
    </div>
  );
}

// Fixes the user marked done, with what happened to the score afterwards.
export function FixesPanel({ d, reload, recheck, rechecking }) {
  const { fixLog, me, project } = d;
  if (!fixLog.length) return null;
  const rows = fixLog.map((l) => ({ l, e: effectOf(l, me) }));
  const waiting = rows.some((r) => r.e.status === 'waiting');
  return (
    <div className="card pad">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div><h2>Fixes you have made</h2><div className="sub" style={{ marginBottom: 6 }}>We re-read your site after each change and show what moved</div></div>
        {waiting && <button className="small no-print" onClick={recheck} disabled={rechecking}>{rechecking ? 'Re-reading your site…' : 'Re-check my site now'}</button>}
      </div>
      {rows.map(({ l, e }) => {
        const [text, tone] = STATUS_TEXT[e.status];
        return (
          <div className="action" key={l.check_name}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <h3>{l.title}</h3>
              <div className="tags">
                <span className={'pill ' + tone}>{text}</span>
                <span className="pill neutral">{AREAS[l.area].label}</span>
                {e.scanned && e.before != null && e.after != null && <span className="pill neutral">{e.before}% → {e.after}%</span>}
                {e.scanned && e.areaPts !== 0 && <span className={'pill ' + (e.areaPts > 0 ? 'good' : 'bad')}>{AREAS[l.area].label} {e.areaPts > 0 ? '+' : ''}{e.areaPts}</span>}
              </div>
              {e.status === 'same' && <div className="sub" style={{ marginTop: 4 }}>Check that the change is live and published, then re-check. {e.note}</div>}
              {e.status === 'worse' && <div className="sub" style={{ marginTop: 4 }}>This check scores lower than when you marked it done. {e.note}</div>}
            </div>
            <button className="ghost small no-print" onClick={async () => { await undoDone(project.id, l.check_name); reload(); }}>Undo</button>
          </div>);
      })}
    </div>
  );
}

// Real Google data for the user's own site, via Search Console (read-only).
export function SearchPanel({ d, reload }) {
  const { project, gsc } = d;
  const [configured, setConfigured] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch('/api/gsc/connect', { cache: 'no-store' }).then((r) => r.json()).then((j) => setConfigured(!!j.configured)).catch(() => setConfigured(false));
    const r = new URLSearchParams(window.location.search).get('gsc');
    if (r) setMsg({ ok: 'Connected. Your Google data is loading below.', nosite: 'You signed in, but that Google account has no verified Search Console property for ' + project.domain + '. Add and verify the site in Search Console first, or choose the account that owns it.', denied: 'Access was not granted, so nothing was connected.', error: 'Something went wrong connecting to Google. Please try again.' }[r] || '');
  }, []);

  async function connect() { setBusy(true); const j = await post('/api/gsc/connect', { projectId: project.id }); if (j.url) window.location.href = j.url; else { setMsg(j.error || 'Could not start.'); setBusy(false); } }
  async function sync() { setBusy(true); const j = await post('/api/gsc/sync', { projectId: project.id }); setMsg(j.ok ? 'Updated.' : j.error || 'Could not refresh.'); setBusy(false); reload(); }
  async function disconnect() { if (!confirm('Disconnect Google Search Console and delete the stored data?')) return; setBusy(true); await post('/api/gsc/disconnect', { projectId: project.id }); setBusy(false); setMsg('Disconnected.'); reload(); }
  async function track(q) { await sb().from('projects').update({ keywords: [...project.keywords, q] }).eq('id', project.id); setMsg(`Now tracking "${q}". It is included from the next daily run.`); reload(); }

  const conn = gsc.conn, snap = gsc.snap;
  const ins = gscInsights(snap, project.keywords);

  return (
    <div className="card pad">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div><h2>Real Google search data</h2><div className="sub">{snap ? `From Google Search Console, ${snap.range.start} to ${snap.range.end}` : 'Your actual searches, clicks and positions, straight from Google'}</div></div>
        <div className="no-print" style={{ display: 'flex', gap: 8 }}>
          {!conn && configured !== false && <button className="small" onClick={connect} disabled={busy || configured === null}>Connect Search Console</button>}
          {conn && conn.status === 'ok' && conn.site_url && <button className="ghost small" onClick={sync} disabled={busy}>Refresh</button>}
          {conn && <button className="ghost small" onClick={disconnect} disabled={busy}>Disconnect</button>}
        </div>
      </div>
      {msg && <div className="note" style={{ marginTop: 10 }}>{msg}</div>}
      {!conn && configured === false && <p className="sub" style={{ marginTop: 10 }}>Search Console is not switched on for this site yet.</p>}
      {!conn && configured !== false && <p className="sub" style={{ marginTop: 10 }}>Read-only access. Shows which searches bring people to you, where you really rank, and which searches are close to page one. Disconnect any time.</p>}
      {conn?.status === 'expired' && <div className="err" style={{ marginTop: 10 }}>Google access was revoked or expired. Disconnect and connect again.</div>}
      {conn?.status === 'nosite' && <div className="err" style={{ marginTop: 10 }}>{conn.error}</div>}
      {conn?.status === 'ok' && conn.site_url && !snap && <p className="sub" style={{ marginTop: 10 }}>Connected to {conn.site_url}. Data will appear after the next refresh. Google data trails by about 3 days.</p>}
      {snap && ins && (
        <>
          <div className="grid g4" style={{ margin: '14px 0' }}>
            {[['Clicks', nf(snap.totals.clicks), ins.deltas.clicks], ['Impressions', nf(snap.totals.impressions), ins.deltas.impressions], ['Average position', snap.totals.position, null], ['Click rate', (snap.totals.ctr * 100).toFixed(1) + '%', null]].map(([l, v, ch]) => (
              <div key={l} className="card sector"><div className="sub">{l}</div><div className="sector-score">{v}</div>{ch != null && <div className={ch >= 0 ? 'up' : 'down'} style={{ fontSize: 12.5 }}>{ch >= 0 ? '+' : ''}{ch}% vs previous 28 days</div>}</div>))}
          </div>
          <div className="grid g2">
            <div>
              <h3>Close to page one</h3><div className="sub" style={{ marginBottom: 6 }}>Ranked 8 to 20 with real impressions. Small improvements here pay off fastest.</div>
              {ins.strike.length ? <table><thead><tr><th>Search</th><th className="r">Position</th><th className="r">Impressions</th></tr></thead><tbody>{ins.strike.map((r) => <tr key={r.query}><td style={{ whiteSpace: 'normal' }}>{r.query}</td><td className="r">{r.position}</td><td className="r">{nf(r.impressions)}</td></tr>)}</tbody></table> : <div className="sub">None yet.</div>}
            </div>
            <div>
              <h3>Searches you are not tracking</h3><div className="sub" style={{ marginBottom: 6 }}>People already find you with these. Track them to compare against competitors.</div>
              {ins.untracked.length ? <table><thead><tr><th>Search</th><th className="r">Impressions</th><th className="r"></th></tr></thead><tbody>{ins.untracked.map((r) => <tr key={r.query}><td style={{ whiteSpace: 'normal' }}>{r.query}</td><td className="r">{nf(r.impressions)}</td><td className="r no-print"><button className="ghost small" onClick={() => track(r.query)}>Track</button></td></tr>)}</tbody></table> : <div className="sub">Every popular search is already tracked.</div>}
            </div>
          </div>
          {ins.lowCtr.length > 0 && <><h3 style={{ marginTop: 16 }}>Ranking well but rarely clicked</h3><div className="sub" style={{ marginBottom: 6 }}>Rewrite the title and description of the page that ranks for these.</div>
            <table><thead><tr><th>Search</th><th className="r">Position</th><th className="r">Click rate</th><th className="r">Impressions</th></tr></thead><tbody>{ins.lowCtr.map((r) => <tr key={r.query}><td style={{ whiteSpace: 'normal' }}>{r.query}</td><td className="r">{r.position}</td><td className="r">{(r.ctr * 100).toFixed(1)}%</td><td className="r">{nf(r.impressions)}</td></tr>)}</tbody></table></>}
        </>
      )}
    </div>
  );
}

// The weekly read of every page on your own site: broken links, redirects, orphan and noindex pages, duplicates, H1 problems.
function Rows({ items, render }) {
  const first = items.slice(0, 10), rest = items.slice(10);
  return (
    <>
      {first.map(render)}
      {rest.length > 0 && <details><summary className="sub" style={{ cursor: 'pointer', padding: '6px 0' }}>Show {rest.length} more</summary>{rest.map(render)}</details>}
    </>
  );
}

function Group({ title, tone, count, hint, children }) {
  return (
    <details className="audit-group" open={count > 0 && count <= 6}>
      <summary><span>{title}</span><span className={'pill ' + tone}>{count}</span></summary>
      <div className="sub" style={{ margin: '6px 0 4px' }}>{hint}</div>
      {children}
    </details>
  );
}

export function AuditPanel({ d, reload }) {
  const a = d.audit;
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState('');
  async function run() {
    setRunning(true); setErr('');
    for (let i = 0; i < 20; i++) {
      const r = await post('/api/project/nudge', { projectId: d.project.id, audit: i === 0 });
      if (!r.ok) { setErr(r.error || 'Could not run the audit. Try again in a minute.'); break; }
      if (!r.pending) break;
    }
    await reload(); setRunning(false);
  }
  const button = <button className="ghost small no-print" onClick={run} disabled={running}>{running ? 'Reading your site…' : a ? 'Run again' : 'Run first audit'}</button>;
  if (!a) {
    return (
      <div className="card pad">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div><h2>Full-site audit</h2><div className="sub">Reads every page of your site and lists broken links, redirects, orphan pages and duplicates. It runs by itself every day. The first one takes about a minute.</div></div>
          {button}
        </div>
        {err && <div className="note" style={{ marginTop: 12 }}>{err}</div>}
      </div>
    );
  }
  const orphans = a.orphans || [];
  const so = a.statusOverview;
  const canon = a.canonicalElsewhere || [], serverErr = a.serverErrors || [], unreachable = a.unreachable || [];
  const total = serverErr.length + unreachable.length + canon.length + a.broken.length + a.redirects.length + a.noindex.length + orphans.length + a.dupDescriptions.length + a.dupTitles.length + a.h1Missing.length + a.h1Multiple.length;
  const from = (x) => `linked from ${x.count} page${x.count === 1 ? '' : 's'}${x.from.length ? ', for example ' + x.from.slice(0, 3).join(', ') : ''}`;
  const row = (key, main, sub) => <div className="audit-row" key={key}><div>{main}</div>{sub && <div className="sub" style={{ fontSize: 12.5 }}>{sub}</div>}</div>;
  return (
    <div className="card pad">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div>
          <h2>Full-site audit</h2>
          <div className="sub">
            Read {a.pages} pages{a.sitemapUrls ? ` of ${a.sitemapUrls} in your sitemap` : ''} and checked {a.linksChecked} links on {a.day}. Runs again every day.
            {!a.complete && <> <span className="pill warn">Partial</span> {a.stopped === 'byte-budget' ? 'The size limit for one crawl was reached before every page was read.' : 'The time limit was reached before every page was read.'}</>}
          </div>
        </div>
        {button}
      </div>
      {so && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>{[['Loaded (200)', so.loaded, 'good'], ['Redirects (3xx)', so.redirected3xx, 'warn'], ['Not found (4xx)', so.clientError4xx, 'bad'], ['Server errors (5xx)', so.serverError5xx, 'bad'], ['Not indexable', so.notIndexable, 'warn'], ['Blocked by robots.txt', so.blockedByRobots, 'neutral']].map(([l, v, t]) => <span key={l} className={'pill ' + (v ? t : 'neutral')}>{l}: {v}</span>)}</div>}
      {so && <div className="sub" style={{ marginTop: 6, fontSize: 12 }}>“Not indexable” means the page says noindex or names a different page as its canonical. Whether Google has actually indexed a page is shown in Search Console.</div>}
      {err && <div className="note" style={{ marginTop: 12 }}>{err}</div>}
      {a.health != null && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 14, alignItems: 'stretch' }}>
          <div className="card" style={{ padding: '12px 16px', minWidth: 150 }}><div className="sub">Site health</div><div className="sector-score">{a.health}<span className="sub">/100</span></div>
            <div className="sub" style={{ fontSize: 12 }}>{a.healthHistory && a.healthHistory.length ? `${a.health - a.healthHistory[a.healthHistory.length - 1].health >= 0 ? '+' : ''}${a.health - a.healthHistory[a.healthHistory.length - 1].health} since ${a.healthHistory[a.healthHistory.length - 1].day}` : 'share of URLs without errors'}</div></div>
          {a.severity && [['Errors', a.severity.error, 'bad'], ['Warnings', a.severity.warning, 'warn'], ['Notices', a.severity.notice, 'neutral']].map(([l, v, t]) => <div key={l} className="card" style={{ padding: '12px 16px', minWidth: 110 }}><div className="sub">{l}</div><div className="sector-score">{v}</div><span className={'pill ' + (v ? t : 'good')}>{v ? 'to review' : 'none'}</span></div>)}
        </div>)}
      {a.health != null && <div className="sub" style={{ marginTop: 6, fontSize: 12 }}>Site health = the share of the {so ? so.requested : ''} URLs we requested that are not broken, did not fail to answer, and do not link to a broken page. Errors count pages affected, so one broken link on ten pages counts ten.</div>}
      {a.changes && a.changes.length > 0 && (
        <div className="card pad" style={{ marginTop: 14 }}>
          <h3 style={{ marginTop: 0 }}>Changes since {a.changesSince}</h3>
          {a.changes.slice(0, 12).map((c) => <div key={c.id} className="audit-row"><div><b>{c.label}</b> <span className={'pill ' + (c.severity === 'error' ? 'bad' : c.severity === 'warning' ? 'warn' : 'neutral')}>{c.was} → {c.now}</span></div>
            <div className="sub" style={{ fontSize: 12.5 }}>{c.addedCount ? `${c.addedCount} new: ${c.added.slice(0, 3).join(', ')}${c.addedCount > 3 ? '…' : ''}. ` : ''}{c.resolvedCount ? `${c.resolvedCount} fixed: ${c.resolved.slice(0, 3).join(', ')}${c.resolvedCount > 3 ? '…' : ''}.` : ''}</div></div>)}
        </div>)}
      {a.changes && a.changes.length === 0 && <div className="note" style={{ marginTop: 12 }}>Nothing changed since the previous audit on {a.changesSince}.</div>}
      {total === 0 && <div className="note" style={{ marginTop: 12 }}>No problems found on the pages we read.</div>}
      <div style={{ marginTop: 8 }}>
        {a.aiBots && <Group title="AI and search crawler access" tone={a.aiBots.some((b) => b.kind !== 'training' && !b.allowed) ? 'warn' : 'neutral'} count={a.aiBots.filter((b) => b.kind !== 'training' && !b.allowed).length} hint="Which crawlers your robots.txt lets read your home page. Search and user bots decide whether you can be listed or cited in AI answers; blocking training bots is a choice about your content being used to train models and does not affect being cited."><Rows items={a.aiBots} render={(b, i) => row(i, <><b>{b.bot}</b> <span className="sub">{b.label}</span> <span className={'pill ' + (b.allowed ? 'good' : b.kind === 'training' ? 'neutral' : 'bad')}>{b.allowed ? 'allowed' : 'blocked'}</span></>, b.kind === 'search' ? 'search and answers' : b.kind === 'user' ? 'fetches a page when a person asks' : 'AI training')} /></Group>}
        {a.hostIssues && a.hostIssues.targets.length > 0 && <Group title="Links to the wrong version of your address" tone="warn" count={a.hostIssues.pagesLinking} hint={`Your site answers on ${a.hostIssues.canonicalHost}. These links use another form (non-www, or http), so every click takes a redirect. Update the links to the exact address.`}><Rows items={a.hostIssues.targets} render={(x, i) => row(i, <><code>{x.url}</code> → <code>{x.to}</code> <span className="pill warn">{x.status}{x.hops > 1 ? `, ${x.hops} hops` : ''}</span></>, `used on ${x.count} page${x.count === 1 ? '' : 's'}${x.pagesSample && x.pagesSample.length ? ', for example ' + x.pagesSample.slice(0, 3).join(', ') : ''}`)} /></Group>}
        {a.redirectChains && a.redirectChains.length > 0 && <Group title="Redirect chains" tone="warn" count={a.redirectChains.length} hint="A redirect that leads to another redirect. Point the first address straight at the final page."><Rows items={a.redirectChains} render={(x, i) => row(i, <><code>{x.url}</code> → <code>{x.to}</code> <span className="pill warn">{x.hops} hops</span></>)} /></Group>}
        {a.orgSchema && (!a.orgSchema.found || a.orgSchema.missing.length > 0) && <Group title="Organization structured data" tone="warn" count={1} hint="Search engines and AI tools use this markup on your home page to describe the business."><Rows items={[a.orgSchema]} render={(x, i) => row(i, x.found ? <>Missing fields: <code>{x.missing.join(', ')}</code></> : <>No Organization or LocalBusiness markup found on the home page. Add: <code>{x.missing.join(', ')}</code></>)} /></Group>}
        {a.schemaCoverage && a.schemaCoverage.some((c) => c.missing.length > 0) && <Group title="Structured data by page type" tone="neutral" count={a.schemaCoverage.reduce((n, c) => n + c.missing.length, 0)} hint="Each kind of page has a structured-data type search engines expect."><Rows items={a.schemaCoverage} render={(x, i) => row(i, <>{x.label}: {x.covered} of {x.pages} have {x.expect}</>, x.missing.length ? 'Missing on: ' + x.missing.slice(0, 4).join(', ') + (x.missing.length > 4 ? '…' : '') : '')} /></Group>}
        {a.performance && <Group title="Server speed and page weight" tone={a.performance.ttfb.slow ? 'warn' : 'neutral'} count={a.performance.ttfb.slow} hint={`Measured one page at a time on ${a.performance.sampled} pages: how fast the server starts answering, and how heavy the page is. Under 200 ms is fast, over 500 ms is slow.`}><Rows items={[a.performance]} render={(x, i) => row(i, <>Median server response <b>{x.medianTtfb} ms</b>, whole page <b>{x.medianTotal} ms</b>, size <b>{x.medianKB} KB</b>, compressed <b>{x.compressedPct}%</b></>, `${x.ttfb.fast} fast · ${x.ttfb.ok} medium · ${x.ttfb.slow} slow${x.slowest.length ? '. Slowest: ' + x.slowest.slice(0, 3).map((s) => `${s.url} (${s.ttfb} ms)`).join(', ') : ''}`)} /></Group>}
        {a.oneInlink && a.oneInlink.length > 0 && <Group title="Pages with only one internal link pointing to them" tone="neutral" count={a.oneInlink.length} hint="Pages with a single internal link are easy for search engines to miss and get little authority. Link to them from more related pages."><Rows items={a.oneInlink} render={(x, i) => row(i, <code>{x}</code>)} /></Group>}
        {a.ogIncomplete && a.ogIncomplete.length > 0 && <Group title="Incomplete social sharing tags (Open Graph)" tone="neutral" count={a.ogIncomplete.length} hint="Missing og:title, og:description or og:image makes shared links look bare on WhatsApp, LinkedIn and Facebook."><Rows items={a.ogIncomplete.slice(0, 40)} render={(x, i) => row(i, <code>{x}</code>)} /></Group>}
        {a.heavyImages && a.heavyImages.length > 0 && <Group title="Images over 300 KB" tone="warn" count={a.heavyImages.length} hint="Compress them or convert to WebP at the size they are shown."><Rows items={a.heavyImages} render={(x, i) => row(i, <><code>{x.url}</code> <span className="pill warn">{x.kb} KB</span></>)} /></Group>}
        {serverErr.length > 0 && <Group title="Server errors (5xx)" tone="bad" count={serverErr.length} hint="The server failed to answer these pages. Ask your host or developer to look at them first."><Rows items={serverErr} render={(x, i) => row(i, <><code>{x.url}</code> <span className="pill bad">{x.status}</span></>, from(x))} /></Group>}
        {unreachable.length > 0 && <Group title="Pages that did not answer" tone="warn" count={unreachable.length} hint="The page did not respond in time. If it keeps showing up, the server may be slow or blocking visitors."><Rows items={unreachable} render={(x, i) => row(i, <><code>{x.url}</code> <span className="pill warn">{String(x.status)}</span></>, from(x))} /></Group>}
        {canon.length > 0 && <Group title="Canonical points to another page" tone="neutral" count={canon.length} hint="These pages tell Google that a different page is the main version, so they are normally left out of search results."><Rows items={canon} render={(x, i) => row(i, <><code>{x.url}</code> → <code>{x.canonical}</code></>)} /></Group>}
        {a.broken.length > 0 && <Group title="Broken links" tone="bad" count={a.broken.length} hint="Links that lead to a page that no longer exists. Change the link, or redirect the old address to the closest page."><Rows items={a.broken} render={(x, i) => row(i, <><code>{x.url}</code> <span className="pill bad">{x.status}</span></>, from(x))} /></Group>}
        {a.redirects.length > 0 && <Group title="Links to redirected pages" tone="warn" count={a.redirects.length} hint="These links work, but send visitors through a redirect. Point the link straight at the final page."><Rows items={a.redirects} render={(x, i) => row(i, <><code>{x.url}</code> → <code>{x.to}</code>{x.loop && <> <span className="pill bad">loop</span></>}</>, from(x))} /></Group>}
        {a.noindex.length > 0 && <Group title="Hidden from Google (noindex)" tone="warn" count={a.noindex.length} hint="These pages tell Google not to list them. Fine for thank-you or login pages, a problem for pages you want customers to find."><Rows items={a.noindex} render={(x, i) => row(i, <code>{x}</code>)} /></Group>}
        {a.orphans === null && <div className="sub" style={{ padding: '12px 0', borderTop: '1px solid var(--line)' }}>Pages with no links pointing to them were not checked, because only part of the site was read.</div>}
        {orphans.length > 0 && <Group title="Pages nothing links to" tone="warn" count={orphans.length} hint="Listed in your sitemap, but no other page links to them, so visitors and Google rarely find them. Link to each from a related page."><Rows items={orphans} render={(x, i) => row(i, <code>{x}</code>)} /></Group>}
        {a.dupDescriptions.length > 0 && <Group title="Shared meta descriptions" tone="neutral" count={a.dupDescriptions.length} hint="Pages that use the same search-result description. Write a unique one for each."><Rows items={a.dupDescriptions} render={(x, i) => row(i, <>“{x.text}”</>, `${x.count} pages: ${x.urls.slice(0, 3).join(', ')}${x.count > 3 ? '…' : ''}`)} /></Group>}
        {a.dupTitles.length > 0 && <Group title="Shared page titles" tone="neutral" count={a.dupTitles.length} hint="Pages with the same title compete with each other. Give each its own."><Rows items={a.dupTitles} render={(x, i) => row(i, <>“{x.text}”</>, `${x.count} pages: ${x.urls.slice(0, 3).join(', ')}${x.count > 3 ? '…' : ''}`)} /></Group>}
        {a.h1Missing.length > 0 && <Group title="Pages without a main heading" tone="warn" count={a.h1Missing.length} hint="Each page needs one H1 that says what the page is about."><Rows items={a.h1Missing} render={(x, i) => row(i, <code>{x}</code>)} /></Group>}
        {a.h1Multiple.length > 0 && <Group title="Pages with more than one main heading" tone="neutral" count={a.h1Multiple.length} hint="Keep one H1 per page and use H2 or H3 for the rest."><Rows items={a.h1Multiple} render={(x, i) => row(i, <code>{x.url}</code>, `${x.count} H1 headings`)} /></Group>}
      </div>
    </div>
  );
}
