'use client';
import { useEffect, useState } from 'react';
import { sb } from '@/lib/supabase-browser';

// The customer-facing "Data health" line. It states when the data was last COMPLETELY updated and says so plainly when it is late or partial,
// instead of printing a fixed "next update tomorrow". Everything comes from the database function project_data_health (migration 0027).
const IST = { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true };
export const istTime = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', IST).replace(/\bam\b/, 'AM').replace(/\bpm\b/, 'PM') + ' IST' : '');

const LABEL = {
  healthy: ['Up to date', 'good'],
  delayed: ['Update in progress', 'warn'],
  degraded: ['Some data is delayed or missing', 'warn'],
  failing: ['Updates are failing. We have been alerted.', 'bad'],
};

export function DataHealth({ projectId, refreshKey, gscConnected, positionsDate }) {
  const [h, setH] = useState(undefined);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let stop = false;
    const load = async () => { try { const { data } = await sb().rpc('project_data_health', { p_project: projectId }); if (!stop) setH(data || null); } catch { if (!stop) setH(null); } };
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 60000);
    return () => { stop = true; clearInterval(t); };
  }, [projectId, refreshKey]);
  if (!h) return h === null ? <div className="sub no-print">Data health is not available right now.</div> : null;
  const [text, tone] = LABEL[h.status] || LABEL.degraded;
  const gaps = (h.gaps || []).filter((g) => g.reason !== 'still waiting');
  const waiting = (h.gaps || []).length - gaps.length;
  return (
    <div className="sub no-print" style={{ lineHeight: 1.6 }}>
      <span className={'pill ' + tone} style={{ marginRight: 8 }}>{text}</span>
      {h.last_success_at ? <>Last complete update: <b>{istTime(h.last_success_at)}</b></> : 'No complete update yet'}
      {h.next_run_at && h.status !== 'failing' ? <> · next scheduled update {istTime(h.next_run_at)}</> : null}
      {(gaps.length > 0 || waiting > 0 || gscConnected || positionsDate || h.today) && <> · <a href="#" onClick={(e) => { e.preventDefault(); setOpen(!open); }}>{open ? 'Hide details' : 'Details'}</a></>}
      {open && (
        <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
          {gaps.length > 0 && <li>Some competitor data is missing today: {gaps.length} site{gaps.length === 1 ? '' : 's'}{h.main_reason ? ` (mostly: ${h.main_reason})` : ''}. Their last known scores are shown.</li>}
          {waiting > 0 && <li>{waiting} site{waiting === 1 ? ' is' : 's are'} still being read.</li>}
          {h.today && h.today.planned > 0 && <li>Today: {h.today.succeeded} of {h.today.planned} sites read.</li>}
          <li>Success rate: {h.success_rate_7d}% of the last 7 days, {h.success_rate_30d}% of the last 30 days.</li>
          {gscConnected && <li>Search Console data is usually delayed by 1 to 2 days.</li>}
          {positionsDate && <li>Google keyword positions were last searched on {positionsDate} and are refreshed weekly.</li>}
          <li>Last attempt: {istTime(h.last_attempt_at) || 'none'}.</li>
        </ul>)}
    </div>
  );
}
