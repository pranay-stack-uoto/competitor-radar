import { authorityFor } from './authority';
import { keywordDataFor } from './keywordData';
import { chargeRun } from './entitlements';
import { siteRecord, benchmark, shareOfVoice } from './industry';
import { collectVitals, isFresh } from './vitals';
import { admin, today } from './db';
import { crawlSite } from './crawl';
import { discover, searchPlaces, brandLookups, suggestKnown, filterCompetitors } from './discover';
import { scoreSite } from './scoring/engine';
import { collectExternal } from './scoring/collect';
import { METHODOLOGY_VERSION, WEIGHTS } from './scoring/config';
import { buildProfile } from './profile';
import { buildChanges } from './changes';
import { syncGsc } from './gsc';
import { buildAudit, attachHistory } from './audit';
import { enqueue, claim, recoverExpired, runClaimedJob, invalidateCrawl } from './queue';
import { getCrawl } from './crawlCache';
import { chargeBudget } from './budget';

const UA = 'CompetitorRadarBot/1.0 (+https://competitor-radar; competitive monitoring)';
// Scoring crawl, same for you and every competitor so the comparison stays fair. Capped at 40 s per site.
const CRAWL = { maxPagesPerSite: 40, delayMs: 200, maxMs: 40000, maxTotalBytes: 100 * 1024 * 1024, userAgent: UA };
// The weekly full-site audit of your own site. Time-capped so one job stays well inside a function's limit.
// Six requests at a time is polite for a site whose owner asked for the audit, and reads roughly five times as many pages in the same 80 s.
const AUDIT = { maxPagesPerSite: 2000, concurrency: 6, frontierMax: 6000, delayMs: 30, maxMs: 80000, maxTotalBytes: 300 * 1024 * 1024, timingSample: 12, hostCheck: true, imageSample: 40, linkCheckMax: 80, userAgent: UA };
const AUDIT_EVERY_DAYS = 1;

// 09:00 job: for every project, queue one discovery job (and a full-site audit if none has run recently).
// Three queries in total, however many projects there are.
// Crawls and searches queued for an earlier day can only produce scores for that day. When a run was missed, the backlog is worked oldest
// first, so today's report waits behind work nobody needs. Retire it (the weekly audit is kept: it is not tied to one day's report).
export async function retireStaleJobs(db, day, projectId) {
  let q = db.from('jobs').update({ status: 'failed', failure_kind: 'permanent', error: 'superseded by a newer day', updated_at: new Date().toISOString() })
    .eq('status', 'queued').lt('day', day).neq('kind', 'audit');
  if (projectId) q = q.eq('project_id', projectId);
  const { error } = await q;
  if (error) console.error('retire stale jobs failed');
}

export async function startDay() {
  const db = admin();
  const day = today();
  await retireStaleJobs(db, day);
  const since = new Date(Date.now() - (AUDIT_EVERY_DAYS + 1) * 86400000).toISOString().slice(0, 10);
  const [{ data: projects }, { data: todays }, { data: audits }] = await Promise.all([
    db.from('projects').select('id,domain,organisation_id').eq('verified', true),
    db.from('jobs').select('project_id').eq('day', day).eq('kind', 'discover'),
    db.from('site_audits').select('project_id,day').gte('day', since),
  ]);
  const hasDiscover = new Set((todays || []).map((j) => j.project_id));
  const recentAudit = new Set((audits || []).filter((a) => (Date.now() - new Date(a.day).getTime()) / 86400000 < AUDIT_EVERY_DAYS).map((a) => a.project_id));
  let queued = 0, paused = 0;
  for (const p of projects || []) {
    // Free trial / plan check: a refresh spends one run. An organisation whose trial or plan has ended is skipped (its data stays readable).
    if (!hasDiscover.has(p.id)) {
      let run;
      try { run = await chargeRun(db, p.organisation_id); } catch { continue; } // cannot count: do not spend
      if (!run.allowed) { paused++; continue; }
    }
    if (!hasDiscover.has(p.id) && await enqueue(db, { projectId: p.id, day, kind: 'discover' })) queued++;
    if (!recentAudit.has(p.id)) await enqueue(db, { projectId: p.id, day, kind: 'audit', domain: p.domain });
  }
  return { projects: projects?.length || 0, queued, paused };
}

// Queues a full-site audit unless a recent one exists (minAgeDays 0 = always, for "run now"). The database refuses a second
// active audit for the same project and day, so concurrent callers cannot double-queue.
export async function queueAudit(db, project, day, minAgeDays) {
  if (minAgeDays > 0) {
    const { data: last } = await db.from('site_audits').select('day').eq('project_id', project.id).order('day', { ascending: false }).limit(1);
    if (last?.[0] && (Date.now() - new Date(last[0].day).getTime()) / 86400000 < minAgeDays) return false;
  }
  return !!(await enqueue(db, { projectId: project.id, day, kind: 'audit', domain: project.domain }));
}

// Takes one job from the queue (atomic claim with a lease), runs it, and records the outcome. Returns false when there is nothing due.
// A crashed worker's job is recovered by the database when its lease expires; a failed job is retried with backoff or marked failed.
export async function workOne() {
  const db = admin();
  const job = await claim(db);
  if (!job) return false;
  // The lease is renewed while the handler runs and every result is committed through a fenced database function (migration 0012), so a
  // worker that lost the job cannot write results, complete it or fail it. runClaimedJob explains each outcome (lib/queue.js).
  await runClaimedJob(db, job, async (lease) => {
    if (job.kind === 'discover') await runDiscovery(db, job, lease);
    else if (job.kind === 'audit') await runAudit(db, job, lease);
    else await runCrawl(db, job, lease);
  });
  return true;
}

// Google searches are the main cost, and they also give the keyword positions. They are run in full once a week (or when asked for with
// "Find new competitors", or when the keyword list changed); on the other days the latest positions are carried forward so the daily
// re-crawl and report still have them, and the report says how old they are.
export const FULL_SEARCH_EVERY_DAYS = 7;
const dayDiff = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);

async function pageAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await build().range(from, from + 999);
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}

const positionsOn = (db, projectId, day) => pageAll(() => db.from('serp_results').select('keyword,location,position,domain,title,url').eq('project_id', projectId).eq('day', day).order('keyword'));

// The newest stored positions no more than 21 days old, whatever their age relative to the weekly search; used when Google cannot be reached.
export async function latestPositions(db, project, job) {
  const { data: latest } = await db.from('serp_results').select('day').eq('project_id', project.id).lte('day', job.day).order('day', { ascending: false }).limit(1);
  const from = latest?.[0]?.day;
  if (!from || dayDiff(job.day, from) > 21) return null;
  return { from, rows: await positionsOn(db, project.id, from) };
}

// Decides whether today's discovery searches Google or reuses the last positions. Returns { full } or { full: false, from, rows }.
export async function searchMode(db, project, job) {
  if (job.domain === 'full') return { full: true };
  const { data: latest } = await db.from('serp_results').select('day').eq('project_id', project.id).lte('day', job.day).order('day', { ascending: false }).limit(1);
  const from = latest?.[0]?.day;
  const searched = project.serp_searched_on || from; // the last REAL search (carried-forward days do not count); older projects: their newest stored day
  if (!from || dayDiff(job.day, searched) >= FULL_SEARCH_EVERY_DAYS) return { full: true };
  const rows = await positionsOn(db, project.id, from);
  const have = new Set(rows.map((r) => r.keyword));
  if (!(project.keywords || []).every((k) => have.has(k))) return { full: true }; // keywords were added: they have no positions yet
  return { full: false, from, rows };
}

async function runDiscovery(db, job, lease) {
  const { data: project } = await db.from('projects').select('*').eq('id', job.project_id).single();
  const mode = await searchMode(db, project, job);
  if (mode.full) {
    try { await searchAndStore(db, job, lease, project); await lease.write('job_mark_search', {}); }
    catch (e) {
      // Google could not be searched properly. Keep today's run useful: use the last stored positions and read the sites; the weekly search is NOT
      // marked done, so it is tried again. With no earlier positions at all, fail the job so the queue retries it.
      if (!e || e.code !== 'serp-failed') throw e;
      const prior = await latestPositions(db, project, job);
      if (!prior || !prior.rows.length) throw e;
      console.error(`discovery for ${project.domain}: ${e.message}; using positions from ${prior.from}`);
      if (prior.from !== job.day) await lease.write('job_write_discovery', { p_serp: prior.rows, p_competitors: [] });
    }
  }
  else if (mode.from !== job.day) await lease.write('job_write_discovery', { p_serp: mode.rows, p_competitors: [] }); // carry the positions forward to today
  lease.assertHeld();
  // Crawl: you + manual competitors + top discovered by SERP strength.
  const { data: comps } = await db.from('competitors').select('domain,source').eq('project_id', project.id).eq('status', 'active').order('serp_score', { ascending: false });
  const manual = (comps || []).filter((c) => c.source === 'manual').map((c) => c.domain);
  const discovered = (comps || []).filter((c) => c.source === 'discovered' && c.domain !== project.domain).slice(0, project.max_competitors).map((c) => c.domain);
  const wanted = [...new Set([project.domain, ...manual, ...discovered])];
  // A refresh only crawls sites that have no score yet today. Sites already queued or running are skipped by the database.
  const { data: scored } = await db.from('scores').select('domain,profile:details->profile').eq('project_id', project.id).eq('day', job.day);
  const have = new Set((scored || []).filter((r) => r.profile).map((r) => r.domain));
  // "Crawl now" (job.domain 'recrawl') reads every site again, even those already scored today, and bypasses the shared crawl cache so the pages are fresh.
  // The daily run and "Find new competitors" only crawl sites that have no score yet today.
  const recrawl = job.domain === 'recrawl';
  if (recrawl) await Promise.all(wanted.map((d) => invalidateCrawl(db, d).catch(() => {})));
  const targets = recrawl ? wanted : wanted.filter((d) => !have.has(d));
  await lease.write('job_enqueue_crawls', { p_domains: targets });
}


async function searchAndStore(db, job, lease, project) {
  const { signal } = lease;
  // Daily spend budget (migration 0015): charged before the money is spent. A refusal fails this job permanently; tomorrow's run tries again.
  const queries = Math.max(1, project.keywords.length) * Math.max(1, project.locations.length);
  await chargeBudget(db, project.organisation_id, 'search', queries + 16);
  await chargeBudget(db, project.organisation_id, 'ai', 2);
  const [web, places, suggested] = await Promise.all([discover(project, { signal }), searchPlaces(project, { signal }).catch(() => ({ candidates: [], rows: [] })), suggestKnown(project, db, { signal }).catch(() => [])]);
  const placesC = places.candidates;
  const { serpRows } = web;
  // Merge the three sources by domain: web results, Google Maps businesses, and well-known names Claude suggested.
  const merged = new Map();
  for (const c of [...web.candidates, ...placesC, ...suggested]) {
    const m = merged.get(c.domain);
    if (m) { m.serp_score += c.serp_score; m.appearances += c.appearances; m.suggested = m.suggested || c.suggested; }
    else merged.set(c.domain, { ...c });
  }
  const candidates = [...merged.values()].sort((a, b) => b.serp_score - a.serp_score);
  lease.assertHeld();
  // Read what is already stored, judge the newcomers, then commit the search results and all competitor changes in ONE fenced transaction.
  const { data: existing } = await db.from('competitors').select('domain,status,source').eq('project_id', project.id);
  const known = new Map((existing || []).map((c) => [c.domain, c]));
  const top = candidates.slice(0, 40);
  // Judge new candidates AND existing bot-found ones. Sites you added or re-enabled by hand (source 'manual'), ones you removed, and Claude-suggested names are left alone.
  const toJudge = top.filter((c) => { const k = known.get(c.domain); return !c.suggested && (!k || (k.source === 'discovered' && k.status === 'active')); });
  const titles = {};
  for (const r of serpRows) if (!titles[r.domain] && r.title) titles[r.domain] = r.title;
  const keep = await filterCompetitors(project, toJudge, titles, db, { signal });
  const changes = [];
  for (const c of top) {
    const prev = known.get(c.domain);
    // Never touch ones the user ignored; hand-added ones only get fresh numbers.
    if (prev?.status === 'ignored' || prev?.source === 'manual') {
      if (prev?.source === 'manual') changes.push({ domain: c.domain, serp_score: c.serp_score, appearances: c.appearances, manual: true });
      continue;
    }
    const judged = toJudge.some((j) => j.domain === c.domain);
    if (judged && keep === null && !prev) continue; // check failed: do not store unjudged newcomers, retry next run
    const status = c.suggested ? 'active' : judged ? (keep === null ? 'active' : keep.has(c.domain) ? 'active' : 'ignored') : (prev?.status || 'active');
    changes.push({ domain: c.domain, name: c.name, serp_score: c.serp_score, appearances: c.appearances, status, manual: false });
  }
  await lease.write('job_write_discovery', { p_serp: serpRows, p_competitors: changes });
  // Google Business Profile tracking: the Maps listings seen above, plus a direct look-up of you and your main competitors by name.
  try {
    lease.assertHeld();
    const { data: top } = await db.from('competitors').select('name,domain').eq('project_id', project.id).eq('status', 'active').order('serp_score', { ascending: false }).limit(5);
    const names = [...new Set([project.name && project.name !== project.domain ? project.name : project.domain.split('.')[0], ...(top || []).map((c) => c.name || c.domain.split('.')[0])].filter(Boolean))];
    await chargeBudget(db, project.organisation_id, 'search', names.length);
    const brand = await brandLookups(project, names, { signal });
    await lease.write('job_write_maps', { p_rows: [...places.rows, ...brand] });
  } catch (e) { if (e && e.name === 'LeaseLostError') throw e; /* Maps data is extra: any other failure (a budget refusal, migration 0025 not applied yet) must not fail the discovery */ }
}

async function runCrawl(db, job, lease) {
  const { data: project } = await db.from('projects').select('*').eq('id', job.project_id).single();
  const { data: ranks } = await db.from('serp_results').select('keyword,location,position').eq('project_id', project.id).eq('day', job.day).eq('domain', job.domain);
  const serpRanks = {};
  for (const k of project.keywords) for (const l of project.locations.length ? project.locations : ['']) serpRanks[`${k}|${l}`] = 0;
  for (const r of ranks || []) serpRanks[`${r.keyword}|${r.location}`] = r.position;

  const cfg = { crawl: CRAWL, keywords: project.keywords, locations: project.locations, aiPrompts: [], signal: lease.signal };
  const isMe = job.domain === project.domain;
  await chargeBudget(db, project.organisation_id, 'crawl', 1);
  // 1. Collect: the raw crawl is shared between customers (lib/crawlCache.js); outside facts are fetched here, not inside scoring.
  const { crawl } = await getCrawl(db, job.domain, { crawlFn: (domain) => crawlSite('https://' + domain, cfg), buildProfile, settings: CRAWL });
  const external = await collectExternal({ crawl, locations: project.locations, aiPrompts: cfg.aiPrompts, siteName: job.domain, signal: lease.signal });
  // Core Web Vitals (display and benchmark only): re-tested at most weekly, the earlier figures are reused in between. Off without PAGESPEED_API_KEY.
  let vitals = null;
  if (process.env.PAGESPEED_API_KEY) {
    const { data: prev } = await db.from('scores').select('vitals:details->profile->vitals').eq('project_id', project.id).eq('domain', job.domain).order('day', { ascending: false }).limit(1);
    vitals = prev?.[0]?.vitals || null;
    if (!isFresh(vitals)) vitals = (await collectVitals({ domain: job.domain, key: process.env.PAGESPEED_API_KEY, signal: lease.signal })) || vitals;
  }
  // 2. Score: a pure function of this project's settings and the crawl (lib/scoring/engine.js).
  const scored = await scoreSite(crawl, { keywords: project.keywords, locations: project.locations }, { site: { name: job.domain }, serpRanks, external });
  const details = { pages: crawl.pages.length, scannedAt: crawl.crawledAt || new Date().toISOString(), profile: { ...buildProfile(crawl), vitals }, methodology: { version: scored.methodVersion, weights: scored.weights }, ...scored.details };
  const r = scored.row;
  await lease.write('job_write_score', { p_is_me: isMe, p_seo: r.seo ?? null, p_geo: r.geo ?? null, p_local: r.local ?? null, p_keywords: r.keywords ?? null, p_overall: scored.overall, p_method_version: METHODOLOGY_VERSION, p_details: details });
}

async function runAudit(db, job, lease) {
  const { data: project } = await db.from('projects').select('id,domain,organisation_id').eq('id', job.project_id).single();
  await chargeBudget(db, project.organisation_id, 'crawl', 5); // a full-site audit reads far more pages than a scoring crawl
  const crawl = await crawlSite('https://' + project.domain, { crawl: AUDIT, signal: lease.signal });
  if (!crawl.pages.length) throw new Error('Could not read any pages of ' + project.domain);
  const audit = buildAudit(crawl);
  // What changed since the previous audit (new and resolved issues) and the health trend, so each report can say what moved.
  const { data: earlier } = await db.from('site_audits').select('day,data').eq('project_id', project.id).lt('day', job.day).order('day', { ascending: false }).limit(30);
  attachHistory(audit, earlier);
  await lease.write('job_write_audit', { p_pages: crawl.pages.length, p_data: audit });
}

// Ranks are assigned once every crawl job for the day has finished.
// How much of the day's planned work the report is built on. `partial` means some sites were still waiting when it was published.
export function coverageOf(planned, scored, unfinished) {
  const total = Math.max(planned || 0, scored || 0);
  return { planned: total, scored: scored || 0, partial: !!unfinished && (scored || 0) < total };
}

export async function finishProjects(onlyId, { partial = false } = {}) {
  const db = admin();
  const day = today();
  await recoverExpired(db);
  let q = db.from('projects').select('id,name,domain');
  if (onlyId) q = q.eq('id', onlyId);
  const { data: projects } = await q;
  const out = [];
  for (const p of projects || []) {
    const { data: pending } = await db.from('jobs').select('id').eq('project_id', p.id).eq('day', day).neq('kind', 'audit').in('status', ['queued', 'running']).limit(1); // the weekly audit never holds back the daily report
    const unfinished = !!pending?.length;
    if (unfinished && !partial) { out.push({ project: p.id, ready: false }); continue; } // a partial publish is only asked for by the daily report cron
    const { data: allScores } = await db.from('scores').select('*').eq('project_id', p.id).eq('day', day).order('overall', { ascending: false });
    const { data: ign } = await db.from('competitors').select('domain').eq('project_id', p.id).eq('status', 'ignored');
    const ignored = new Set((ign || []).map((c) => c.domain));
    const scores = (allScores || []).filter((s) => s.is_me || !ignored.has(s.domain));
    if (!scores.length) continue;
    const { error: rankError } = await db.rpc('set_ranks', { p_project: p.id, p_day: day, p_domains: scores.map((x) => x.domain) }); // one statement, not one UPDATE per site
    if (rankError) throw new Error('set_ranks: ' + rankError.message);
    const { data: prevDay } = await db.from('scores').select('day').eq('project_id', p.id).lt('day', day).order('day', { ascending: false }).limit(1);
    const prevRows = prevDay?.[0] ? ((await db.from('scores').select('*').eq('project_id', p.id).eq('day', prevDay[0].day)).data || []) : [];
    const prev = Object.fromEntries(prevRows.map((r) => [r.domain, r]));
    const me = scores.find((s) => s.is_me);
    if (unfinished && !me) { out.push({ project: p.id, ready: false }); continue; } // never publish a partial report without the customer's own site
    const { count: planned } = await db.from('jobs').select('id', { count: 'exact', head: true }).eq('project_id', p.id).eq('day', day).eq('kind', 'crawl');
    const { data: kwProject } = await db.from('projects').select('keywords,organisation_id').eq('id', p.id).single();
    // Real search volumes for the tracked keywords (display only). Cached; charged to the search budget; empty without an API key.
    const keywordVolumes = await keywordDataFor(db, kwProject?.keywords || [], { country: process.env.KEYWORDS_EVERYWHERE_COUNTRY || 'in', charge: (n) => chargeBudget(db, kwProject?.organisation_id, 'search', n) });
    const authority = await authorityFor(db, scores.map((s) => s.domain)); // empty when no Open PageRank key is configured
    const board = scores.map((s, i) => ({ domain: s.domain, authority: authority[s.domain]?.pageRank ?? null, globalRank: authority[s.domain]?.globalRank ?? null, is_me: s.is_me, rank: i + 1, overall: s.overall, seo: s.seo, geo: s.geo, local: s.local, keywords: s.keywords, rankChange: prev[s.domain] ? prev[s.domain].rank - (i + 1) : null, scoreChange: prev[s.domain] ? Math.round((s.overall - prev[s.domain].overall) * 10) / 10 : null }));
    const leader = board[0];
    const gaps = me ? ['seo', 'geo', 'local', 'keywords'].map((k) => ({ area: k, mine: me[k], best: Math.max(...scores.map((s) => s[k] || 0)) })).filter((g) => g.best - g.mine > 10).sort((a, b) => (b.best - b.mine) - (a.best - a.mine)) : [];
    const { data: newComps } = await db.from('competitors').select('domain').eq('project_id', p.id).eq('first_seen', day).eq('source', 'discovered');
    const ranked = scores.map((s, i) => ({ ...s, rank: i + 1 }));
    const changes = buildChanges(prevRows.filter((r) => r.is_me || !ignored.has(r.domain)), ranked);
    const summary = { day, coverage: coverageOf(planned, scores.length, unfinished), keywordVolumes, board, leader: leader.domain, myRank: me ? board.find((b) => b.is_me)?.rank : null, total: board.length, gaps, newCompetitors: (newComps || []).map((c) => c.domain), changes, changesSince: prevDay?.[0]?.day || null };
    const { data: prevRep } = await db.from('reports').select('summary').eq('project_id', p.id).eq('day', day).maybeSingle();
    if (prevRep?.summary?.ai) summary.ai = prevRep.summary.ai; // keep generated AI insights when a refresh re-ranks the day
    await db.from('reports').upsert({ project_id: p.id, day, summary });
    // Industry snapshot: how you compare with this market today, kept so the next report can show what moved (lib/industry.js, migration 0024).
    try {
      const mineRec = me && siteRecord(me.domain, me.overall, me.details?.profile);
      const otherRecs = scores.filter((x) => !x.is_me).map((x) => siteRecord(x.domain, x.overall, x.details?.profile)).filter(Boolean);
      const bm = benchmark(mineRec, otherRecs);
      const serpToday = await pageAll(() => db.from('serp_results').select('keyword,location,position,domain').eq('project_id', p.id).eq('day', day).order('keyword'));
      const voice = shareOfVoice(serpToday, scores.map((x) => x.domain));
      if (bm) await db.from('industry_snapshots').upsert({ project_id: p.id, day, sites: bm.sites, top_sites: bm.topSites, metrics: bm.metrics, adoption: bm.adoption, voice }, { onConflict: 'project_id,day' });
    } catch { /* the snapshot is extra: never block the report */ }
    await syncGsc(db, p.id).catch(() => {}); // Search Console is optional and must never block the report
    out.push({ project: p.id, ready: true, partial: unfinished });
  }
  return out;
}

// Works the queue until empty or out of time, then publishes any project whose jobs are all finished.
export async function runQueue(budgetMs, onlyId) {
  const deadline = Date.now() + budgetMs;
  let done = 0, more = true;
  while (Date.now() < deadline && (more = await workOne())) done++;
  if (!more) await finishProjects(onlyId);
  return { done, more };
}
