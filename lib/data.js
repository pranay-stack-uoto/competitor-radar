'use client';
import { sb } from './supabase-browser';
import { buildActions, AREAS } from './recommendations';

// How much score history the charts load. Older rows stay in the database; they are just not sent to the browser.
const HISTORY_DAYS = 120;

// Everything the dashboard and the report need, loaded with the signed-in user's own access (RLS applies).
export async function loadProjectData() {
  const c = sb();
  const { data: s } = await c.auth.getSession();
  if (!s.session) { window.location.href = '/login'; return null; }
  const { data: projects } = await c.from('projects').select('*').order('created_at');
  const project = projects?.[0];
  if (!project || !project.verified || !project.keywords.length) { window.location.href = '/onboarding'; return null; }

  const [{ data: report }, { data: comps }, { data: hist }, { data: latestDay }, { data: fixLog }, { data: gscConn }, { data: gscSnap }, { data: audit }, { data: industry }] = await Promise.all([
    c.from('reports').select('*').eq('project_id', project.id).order('day', { ascending: false }).limit(1).maybeSingle(),
    c.from('competitors').select('*').eq('project_id', project.id).order('serp_score', { ascending: false }),
    c.from('scores').select('day,domain,overall,seo,geo,local,keywords,is_me,method_version').eq('project_id', project.id).gte('day', new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString().slice(0, 10)).order('day'),
    c.from('reports').select('day').eq('project_id', project.id).order('day', { ascending: false }).limit(1),
    c.from('action_log').select('*').eq('project_id', project.id).order('done_at', { ascending: false }),
    c.from('gsc_connections').select('*').eq('project_id', project.id).maybeSingle(),
    c.from('gsc_snapshots').select('day,data').eq('project_id', project.id).order('day', { ascending: false }).limit(1).maybeSingle(),
    c.from('site_audits').select('day,pages,data').eq('project_id', project.id).order('day', { ascending: false }).limit(1).maybeSingle(),
    c.from('industry_snapshots').select('day,sites,top_sites,metrics,adoption,voice').eq('project_id', project.id).order('day').limit(90), // missing before migration 0024: then just empty
  ]);

  // Google Maps listings (migration 0025): the latest check and the one before it, so review growth can be shown. Empty before the migration.
  let maps = { rows: [], prevRows: [], day: null, prevDay: null };
  try {
    const { data: dd } = await c.from('maps_results').select('day').eq('project_id', project.id).order('day', { ascending: false }).limit(1);
    const day = dd?.[0]?.day;
    if (day) {
      const { data: rows } = await c.from('maps_results').select('keyword,location,position,domain,name,rating,rating_count,category,phone').eq('project_id', project.id).eq('day', day).limit(1000);
      const { data: pd } = await c.from('maps_results').select('day').eq('project_id', project.id).lt('day', day).order('day', { ascending: false }).limit(1);
      const prevDay = pd?.[0]?.day || null;
      const { data: prevRows } = prevDay ? await c.from('maps_results').select('keyword,location,position,domain,name,rating,rating_count,category,phone').eq('project_id', project.id).eq('day', prevDay).limit(1000) : { data: [] };
      maps = { rows: rows || [], prevRows: prevRows || [], day, prevDay };
    }
  } catch { /* the Maps section simply stays empty */ }

  let scores = [], serp = [];
  if (report) {
    const day = report.day;
    const [a, b] = await Promise.all([
      c.from('scores').select('*').eq('project_id', project.id).eq('day', day),
      c.from('serp_results').select('keyword,location,position,domain').eq('project_id', project.id).eq('day', day).lte('position', 10),
    ]);
    const ignored = new Set((comps || []).filter((x) => x.status === 'ignored').map((x) => x.domain));
    scores = (a.data || []).filter((x) => x.is_me || !ignored.has(x.domain));
    serp = b.data || [];
  }

  const me = scores.find((x) => x.is_me);
  const others = scores.filter((x) => !x.is_me);
  // Best competitor value per check, per area, so each action can say "the best competitor scores X".
  const benchmarks = {};
  for (const area of Object.keys(AREAS)) {
    benchmarks[area] = {};
    for (const o of others) for (const ch of o.details?.[area]?.checks || []) {
      if (ch.value == null) continue;
      benchmarks[area][ch.name] = Math.max(benchmarks[area][ch.name] ?? 0, ch.value);
    }
  }
  const best = {}, avg = {};
  for (const area of Object.keys(AREAS)) {
    const vals = others.map((o) => o[area] ?? 0);
    best[area] = vals.length ? Math.max(...vals) : 0;
    avg[area] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  const actions = me ? buildActions(me.details, benchmarks, { keywords: project.keywords, locations: project.locations, brand: (project.name && project.name !== project.domain ? project.name : project.domain.split('.')[0]) }) : [];
  return { project, report, comps: comps || [], hist: hist || [], scores, me, others, serp, actions, best, avg, latestDay: latestDay?.[0]?.day, fixLog: fixLog || [], gsc: { conn: gscConn || null, snap: gscSnap?.data || null, day: gscSnap?.day || null }, audit: audit ? { day: audit.day, ...audit.data } : null, industry: industry || [], maps };
}
