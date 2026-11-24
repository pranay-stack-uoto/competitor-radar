// The daily monitor: turns audit anomalies and broken audit chains into alerts (monitor_run, migration 0014), then tells a human.
// Delivery needs no paid service: critical alerts are always written to the server log (Vercel logs), and if ALERT_WEBHOOK_URL is set
// (a free Slack, Discord or Teams incoming webhook, or any HTTPS endpoint) the alerts and the audit head hash are posted there.
// The head hash posted outside the database is what makes tampering with the audit table detectable even if the whole table is rewritten.
const { validateUrl } = require('./security/netguard');

const line = (a) => `[${a.severity}] ${a.kind}${a.subject ? ' ' + a.subject : ''}${a.organisation_id ? ' org ' + String(a.organisation_id).slice(0, 8) : ''} ${JSON.stringify(a.detail || {})}`.slice(0, 400);

async function runMonitors(db, { env = process.env, fetchFn = globalThis.fetch, log = console.error } = {}) {
  const out = { raised: 0, sent: 0, webhook: false, head: null };
  const { data: raised, error: monitorError } = await db.rpc('monitor_run');
  if (monitorError) {
    if (monitorError.code === 'PGRST202' || monitorError.code === '42883') return { ...out, skipped: 'migration 0014 not applied' };
    log('monitor_run failed:', String(monitorError.code || 'error')); return { ...out, error: true };
  }
  out.raised = Number(raised) || 0;
  const { data: pending } = await db.from('alerts').select('id,kind,severity,organisation_id,subject,detail').is('notified_at', null).order('id').limit(50);
  const alerts = pending || [];
  for (const a of alerts) if (a.severity === 'critical') log('ALERT', line(a));
  const { data: head } = await db.rpc('audit_head');
  const h = Array.isArray(head) ? head[0] : head;
  out.head = h ? { id: h.id, hash: h.hash } : null;

  let url = null;
  if (env.ALERT_WEBHOOK_URL) { try { url = validateUrl(env.ALERT_WEBHOOK_URL); if (url.protocol !== 'https:') url = null; } catch { url = null; } if (!url) log('ALERT_WEBHOOK_URL is not a valid public https address; alerts are only logged'); }
  if (url && (alerts.length || out.head)) {
    const text = [`Competitor Radar daily check: ${alerts.length} new alert${alerts.length === 1 ? '' : 's'}`, ...alerts.map(line), out.head ? `audit head #${out.head.id} ${out.head.hash}` : ''].filter(Boolean).join('\n');
    try {
      const res = await fetchFn(url.href, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        out.webhook = true; out.sent = alerts.length;
        if (alerts.length) await db.from('alerts').update({ notified_at: new Date().toISOString() }).in('id', alerts.map((a) => a.id));
      } else log('alert webhook answered', res.status);
    } catch (e) { log('alert webhook failed:', String((e && e.name) || 'error')); }
  }
  return out;
}
module.exports = { runMonitors };
