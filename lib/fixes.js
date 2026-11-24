'use client';
import { sb } from './supabase-browser';

const checkOf = (me, area, name) => me?.details?.[area]?.checks?.find((c) => c.name === name);

// What to remember when someone says "I did this": the numbers as they stand right now.
export function baselineFor(a, me, day) {
  const c = checkOf(me, a.area, a.check);
  return { value: c?.value ?? null, note: c?.note || '', area: Number(me[a.area]), overall: Number(me.overall), day };
}

export async function markDone(projectId, a, me, day) {
  await sb().from('action_log').upsert({ project_id: projectId, check_name: a.check, area: a.area, title: a.title, done_at: new Date().toISOString(), baseline: baselineFor(a, me, day) });
}
export async function undoDone(projectId, check) { await sb().from('action_log').delete().eq('project_id', projectId).eq('check_name', check); }

// Compare the check now with the check when it was marked done. "scanned" means the site was re-read after that moment.
export function effectOf(log, me) {
  const c = checkOf(me, log.area, log.check_name);
  const b = log.baseline || {};
  const scannedAt = me?.details?.scannedAt;
  const scanned = scannedAt ? new Date(scannedAt) > new Date(log.done_at) : false;
  const now = c?.value ?? null;
  const delta = now != null && b.value != null ? now - b.value : null;
  const pts = (x) => Math.round(x * 10) / 10;
  const status = !scanned ? 'waiting' : now != null && now >= 0.85 ? 'fixed' : delta != null && delta >= 0.1 ? 'better' : delta != null && delta <= -0.1 ? 'worse' : 'same';
  return {
    status, scanned, before: b.value != null ? Math.round(b.value * 100) : null, after: now != null ? Math.round(now * 100) : null,
    areaPts: pts(Number(me[log.area]) - (b.area ?? Number(me[log.area]))), overallPts: pts(Number(me.overall) - (b.overall ?? Number(me.overall))), note: c?.note || '',
  };
}
export const STATUS_TEXT = {
  waiting: ['Waiting for the next scan', 'neutral'],
  fixed: ['Verified fixed', 'good'],
  better: ['Improved, not complete yet', 'good'],
  same: ['No change detected yet', 'warn'],
  worse: ['Got worse', 'bad'],
};
