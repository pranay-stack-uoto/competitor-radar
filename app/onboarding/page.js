'use client';
import { useEffect, useState } from 'react';
import { sb } from '@/lib/supabase-browser';
import { Nav } from '../components';

const cleanDomain = (s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
const split = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
const STEPS = ['site', 'verify', 'review'];

export default function Onboarding() {
  const [step, setStep] = useState('loading');     // site -> verify -> reading -> review
  const [project, setProject] = useState(null);
  const [url, setUrl] = useState('');
  const [method, setMethod] = useState('dns');
  const [ai, setAi] = useState({ summary: '', source: '' });
  const [kws, setKws] = useState([]);
  const [locs, setLocs] = useState([]);
  const [onK, setOnK] = useState(new Set());
  const [onL, setOnL] = useState(new Set());
  const [extraK, setExtraK] = useState('');
  const [extraL, setExtraL] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');

  const call = async (path, body) => {
    const t = (await sb().auth.getSession()).data.session?.access_token;
    if (!t) { window.location.href = '/login'; return {}; }
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: JSON.stringify(body) });
    return { ok: r.ok, ...(await r.json()) };
  };

  useEffect(() => {
    (async () => {
      const c = sb();
      const { data: s } = await c.auth.getSession();
      if (!s.session) { window.location.href = '/login'; return; }
      const { data: ps } = await c.from('projects').select('*').order('created_at', { ascending: false }).limit(1);
      const p = ps?.[0];
      if (!p) return setStep('site');
      setProject(p);
      if (p.verified && p.keywords.length) { window.location.href = '/dashboard'; return; }
      p.verified ? runExtract(p) : setStep('verify');
    })();
  }, []);

  async function addSite(e) {
    e.preventDefault(); setMsg('');
    const domain = cleanDomain(url);
    if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return setMsg('Enter your website address, like yourcompany.com (not an email address or an IP address).');
    setBusy('Adding…');
    const { data: s } = await sb().auth.getSession();
    const { data: p, error } = await sb().from('projects').insert({ user_id: s.session.user.id, name: domain, url: 'https://' + domain, domain }).select().single();
    setBusy('');
    if (error) return setMsg(error.code === '23505' ? 'You have already added this website.' : error.code === '23514' ? 'That does not look like a valid website name.' : 'We could not add that website. Please try again.');
    setProject(p); setStep('verify');
  }
  async function verify() {
    setBusy('Checking…'); setMsg('');
    const r = await call('/api/verify', { projectId: project.id });
    setBusy('');
    if (r.verified) { const p = { ...project, verified: true }; setProject(p); runExtract(p); } else setMsg(r.error || 'Verification failed.');
  }
  async function runExtract(p) {
    setStep('reading'); setMsg('');
    const r = await call('/api/extract', { projectId: p.id });
    if (!r.ok) { setMsg(r.error || 'Could not read your site.'); setStep('review'); return; }
    setAi({ summary: r.summary, source: r.source });
    setKws(r.keywords); setLocs(r.locations); setOnK(new Set(r.keywords)); setOnL(new Set(r.locations));
    setStep('review');
  }
  const flip = (set, setSet, v) => { const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); setSet(n); };
  async function save() {
    const keywords = [...new Set([...onK, ...split(extraK)])];
    const locations = [...new Set([...onL, ...split(extraL)])];
    if (!keywords.length) return setMsg('Pick or add at least one keyword.');
    setBusy('Starting…'); setMsg('');
    const { error } = await sb().from('projects').update({ keywords, locations, summary: ai.summary }).eq('id', project.id);
    if (error) { setBusy(''); return setMsg(error.code === '23514' ? 'Too many keywords or locations. Keep it to 30 keywords and 12 locations, each under 120 characters.' : 'We could not save that. Please try again.'); }
    await call('/api/project/start', { projectId: project.id });
    window.location.href = '/dashboard';
  }

  const Chips = ({ items, on, setOn }) => <div className="chips">{items.map((k) => <span key={k} className={'chip' + (on.has(k) ? ' on' : '')} onClick={() => flip(on, setOn, k)}>{k}</span>)}</div>;
  const t = project?.verify_token, d = project?.domain;
  const idx = step === 'site' ? 0 : step === 'verify' ? 1 : 2;

  return (
    <>
      <Nav />
      <div className="wrap" style={{ maxWidth: 640 }}>
        <div className="stepper">{STEPS.map((s, i) => <div key={s} className={'step' + (i <= idx ? ' on' : '')} />)}</div>
        <div className="card pad">
          {step === 'loading' && <div className="skeleton" style={{ height: 120 }} />}

          {step === 'site' && (
            <form onSubmit={addSite}>
              <h1>Add your website</h1>
              <p className="sub" style={{ marginBottom: 18 }}>Step 1 of 3. We will read it to learn what you do and where you work. Only you can see your reports.</p>
              <label>Your website address</label>
              <input autoFocus placeholder="yourcompany.com" value={url} onChange={(e) => setUrl(e.target.value)} />
              {msg && <div className="err">{msg}</div>}
              <button disabled={!!busy}>{busy || 'Continue'}</button>
            </form>
          )}

          {step === 'verify' && project && (
            <div>
              <h1>Confirm you own {d}</h1>
              <p className="sub" style={{ marginBottom: 14 }}>Step 2 of 3. Add one of these to your website. It proves the site is yours, and we only read public pages.</p>
              <div className="chips">{[['dns', 'DNS record (recommended)'], ['meta', 'Meta tag'], ['file', 'Upload a file']].map(([k, l]) => <span key={k} className={'chip' + (method === k ? ' on' : '')} onClick={() => setMethod(k)}>{l}</span>)}</div>
              {method === 'dns' && <div className="note">At your domain provider, add a <b>TXT</b> record.<br />Name: <code>_radar-verify</code><br />Value: <code>{t}</code></div>}
              {method === 'meta' && <div className="note">Add this inside the <code>&lt;head&gt;</code> of your homepage and publish:<br /><code>{`<meta name="radar-verify" content="${t}">`}</code></div>}
              {method === 'file' && <div className="note">Create a text file at <code>{`https://${d}/radar-verify-${t}.txt`}</code> that contains only:<br /><code>{t}</code></div>}
              {msg && <div className="err">{msg}</div>}
              <button disabled={!!busy} onClick={verify}>{busy || 'Verify ownership'}</button>
              <p className="sub" style={{ marginTop: 12, fontSize: 13 }}>DNS changes can take a few minutes to appear. If it says not found, wait and try again.</p>
            </div>
          )}

          {step === 'reading' && (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <span className="spinner" style={{ width: 30, height: 30 }} />
              <h2 style={{ marginTop: 16 }}>Reading your website</h2>
              <p className="sub">Finding your services and the places you work. This takes under a minute.</p>
            </div>
          )}

          {step === 'review' && (
            <div>
              <h1>Check what we found</h1>
              <p className="sub" style={{ marginBottom: 14 }}>Step 3 of 3. Remove anything wrong and add what is missing. This decides who we treat as your competitors.</p>
              {ai.summary && <div className="note">{ai.summary}</div>}
              {ai.source === 'basic' && <div className="note">AI analysis is switched off, so places could not be detected. Add them below.</div>}
              <label>Keywords your customers search for</label>
              <Chips items={kws} on={onK} setOn={setOnK} />
              <input value={extraK} onChange={(e) => setExtraK(e.target.value)} placeholder="Add more, separated by commas" />
              <label>Places you serve</label>
              <Chips items={locs} on={onL} setOn={setOnL} />
              <input value={extraL} onChange={(e) => setExtraL(e.target.value)} placeholder="Add more, separated by commas" />
              {msg && <div className="err">{msg}</div>}
              <div style={{ display: 'flex', gap: 8 }}>
                <button disabled={!!busy} onClick={save}>{busy || 'Find my competitors'}</button>
                <button className="ghost" onClick={() => runExtract(project)}>Read again</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
