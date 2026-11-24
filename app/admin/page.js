'use client';
import { useEffect, useState } from 'react';
import { sb } from '@/lib/supabase-browser';
import { Nav } from '../components';
import { istTime } from '../datahealth';

// Operator view of the daily run. The server refuses everyone who is not listed in ADMIN_EMAILS (a plain 404), so this page shows nothing to others.
export default function Admin() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  async function load() {
    const t = (await sb().auth.getSession()).data.session?.access_token;
    if (!t) { window.location.href = '/login'; return; }
    const r = await fetch('/api/admin/ops', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: '{}' });
    if (!r.ok) { setErr(r.status === 404 ? 'Not found.' : 'Could not load.'); return; }
    setD(await r.json()); setErr('');
  }
  useEffect(() => { load(); const i = setInterval(load, 30000); return () => clearInterval(i); }, []);
  if (err) return <><Nav /><div className="wrap"><div className="card empty">{err}</div></div></>;
  if (!d) return <><Nav /><div className="wrap"><div className="skeleton" style={{ height: 200 }} /></div></>;
  const pill = (s) => <span className={'pill ' + ({ healthy: 'good', delayed: 'warn', degraded: 'warn', failing: 'bad', failed: 'bad', dead_letter: 'bad', retrying: 'warn' }[s] || 'neutral')}>{s}</span>;
  return (
    <>
      <Nav />
      <div className="wrap">
        <h1>Operations</h1>
        <div className="sub">Refreshed {istTime(d.generated_at)} · crawl success, last 7 days: <b>{d.crawl_success_7d ?? 'n/a'}{d.crawl_success_7d != null ? '%' : ''}</b></div>

        <h2 style={{ marginTop: 22 }}>Customers affected</h2>
        {d.affected.length ? <div className="card tbl-wrap"><table><thead><tr><th>Project</th><th>Plan</th><th>Status</th><th>Main reason</th></tr></thead>
          <tbody>{d.affected.map((a) => <tr key={a.domain}><td>{a.domain}</td><td>{a.plan}</td><td>{pill(a.status)}</td><td>{a.reason || ''}</td></tr>)}</tbody></table></div> : <div className="note">No customer is degraded or failing.</div>}

        <h2 style={{ marginTop: 22 }}>Queue, last two days</h2>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{Object.entries(d.queue).map(([k, v]) => <div key={k} className="card" style={{ padding: '10px 14px' }}><div className="sub">{k}</div><div className="sector-score">{v}</div></div>)}</div>

        <h2 style={{ marginTop: 22 }}>Failed, retrying and stuck jobs (24 h)</h2>
        {d.problems.length ? <div className="card tbl-wrap"><table><thead><tr><th>When</th><th>Project</th><th>Job</th><th>State</th><th>Attempts</th><th>Reason</th><th>Error</th></tr></thead>
          <tbody>{d.problems.map((p, i) => <tr key={i}><td>{istTime(p.updated_at)}</td><td>{p.project}</td><td>{p.kind}{p.domain ? ` · ${p.domain}` : ''}</td><td>{pill(p.state)}</td><td>{p.attempts}</td><td>{p.reason}</td><td className="sub" style={{ whiteSpace: 'normal' }}>{p.error}</td></tr>)}</tbody></table></div> : <div className="note">None.</div>}

        <h2 style={{ marginTop: 22 }}>Every project</h2>
        <div className="card tbl-wrap"><table><thead><tr><th>Project</th><th>Plan</th><th>Status</th><th>Last complete update</th><th>Today</th><th>7 d</th><th>30 d</th></tr></thead>
          <tbody>{d.projects.map((p) => <tr key={p.domain}><td>{p.domain}</td><td>{p.plan}</td><td>{pill(p.health?.status)}</td><td>{istTime(p.health?.last_success_at)}</td>
            <td>{p.health ? `${p.health.today.succeeded}/${p.health.today.planned}${p.health.today.dead_letter ? ` · ${p.health.today.dead_letter} dead` : ''}` : ''}</td><td>{p.health?.success_rate_7d}%</td><td>{p.health?.success_rate_30d}%</td></tr>)}</tbody></table></div>

        <h2 style={{ marginTop: 22 }}>Recent alerts</h2>
        {d.alerts.length ? <div className="card tbl-wrap"><table><thead><tr><th>When</th><th>Kind</th><th>Severity</th><th>Subject</th><th>Detail</th></tr></thead>
          <tbody>{d.alerts.map((a) => <tr key={a.id}><td>{istTime(a.created_at)}</td><td>{a.kind}</td><td>{a.severity}</td><td>{a.subject}</td><td className="sub" style={{ whiteSpace: 'normal' }}>{JSON.stringify(a.detail)}</td></tr>)}</tbody></table></div> : <div className="note">No alerts.</div>}

        <h2 style={{ marginTop: 22 }}>Feature flags</h2>
        {d.flags.length ? <div className="card tbl-wrap"><table><thead><tr><th>Flag</th><th>Scope</th><th>On</th></tr></thead><tbody>{d.flags.map((f, i) => <tr key={i}><td>{f.key}</td><td>{f.organisation_id ? 'one organisation' : 'everyone'}</td><td>{f.enabled ? 'yes' : 'no'}</td></tr>)}</tbody></table></div> : <div className="note">No flags set (everything defaults to off).</div>}
      </div>
    </>
  );
}
