'use client';
import { useState } from 'react';
import { sb } from '@/lib/supabase-browser';
import { Logo } from '../components';
import { LEGAL_VERSION } from '@/lib/legal-version';
import { CONSENT_FLAG } from '../consent';

// Passwordless: email a sign-in link or 6-digit code. Creates the account on first use.
export default function Login() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [agree, setAgree] = useState(false);

  async function sendCode(e) {
    if (!agree) { e.preventDefault(); setMsg('Please tick the box to accept the Terms and Privacy Policy.'); return; }
    try { localStorage.setItem(CONSENT_FLAG, LEGAL_VERSION); } catch {} // recorded in the database right after sign-in (app/consent.js)
    e.preventDefault(); setBusy(true); setMsg('');
    const { error } = await sb().auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    setBusy(false);
    if (error) return setMsg(/rate|seconds|limit/i.test(error.message) ? 'Too many emails were requested. Wait a minute and try again.' : error.message);
    setSent(true);
  }
  async function verify(e) {
    e.preventDefault(); setBusy(true); setMsg('');
    const { data, error } = await sb().auth.verifyOtp({ email, token: code.trim(), type: 'email' });
    setBusy(false);
    if (error || !data.session) return setMsg('That code is wrong or has expired. Request a new one.');
    window.location.href = '/dashboard';
  }

  return (
    <div className="auth">
      <div className="auth-side">
        <div className="brand" style={{ color: '#fff' }}><Logo />Competitor Radar</div>
        <div>
          <h2>Know who you compete with, and how to beat them.</h2>
          <ul style={{ padding: 0, listStyle: 'none', marginTop: 24 }}>
            <li>✓ Competitors found automatically from Google for your keywords and cities</li>
            <li>✓ Ranked every day on SEO, AI visibility, local search and keywords</li>
            <li>✓ A downloadable plan showing exactly what to fix first</li>
          </ul>
        </div>
        <svg viewBox="0 0 360 110" width="100%" style={{ maxWidth: 420, opacity: .95 }} aria-hidden="true">
          {[20, 55, 90].map((y) => <line key={y} x1="0" x2="360" y1={y} y2={y} stroke="#fff" strokeOpacity=".12" strokeDasharray="3 5" />)}
          <path d="M0 88 C60 84 90 70 140 66 S230 58 270 44 S330 30 360 22" pathLength="1" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" className="draw" />
          <path d="M0 92 C70 90 110 84 160 80 S250 74 300 66 S340 60 360 58" pathLength="1" fill="none" stroke="#a5b4fc" strokeWidth="2" strokeLinecap="round" className="draw" style={{ animationDelay: '.25s' }} />
          <path d="M0 100 C60 98 120 92 180 90 S280 84 360 80" pathLength="1" fill="none" stroke="#f9a8d4" strokeWidth="2" strokeLinecap="round" className="draw" style={{ animationDelay: '.45s' }} />
          <circle cx="360" cy="22" r="4.5" fill="#fff" className="fade" style={{ animationDelay: '1.1s' }} />
        </svg>
        <div style={{ opacity: .7, fontSize: 13 }}>Updated every morning. No setup beyond your website.</div>
      </div>
      <div className="auth-form"><div className="auth-box">
        <h1>{sent ? 'Check your email' : 'Sign in or create an account'}</h1>
        {!sent ? (
          <form onSubmit={sendCode}>
            <p className="sub" style={{ marginBottom: 18 }}>No password needed. We email you a secure sign-in link.</p>
            <label>Work email</label>
            <input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13.5, margin: '12px 0' }}>
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} style={{ marginTop: 3, width: 'auto' }} />
              <span>I have read and agree to the <a href="/terms" target="_blank" rel="noopener">Terms of Service</a> and the <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</span>
            </label>
            {msg && <div className="err">{msg}</div>}
            <button disabled={busy || !agree} style={{ width: '100%', justifyContent: 'center' }}>{busy ? 'Sending…' : 'Continue with email'}</button>
          </form>
        ) : (
          <form onSubmit={verify}>
            <p className="sub" style={{ marginBottom: 18 }}>We emailed <b>{email}</b>. Enter the 6-digit code from the email below, or click the link in the email in this same browser. Check spam if you do not see it.</p>
            <label>6-digit code</label>
            <input inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
            {msg && <div className="err">{msg}</div>}
            <button disabled={busy || !code} style={{ width: '100%', justifyContent: 'center' }}>{busy ? 'Checking…' : 'Sign in with code'}</button>
            <p style={{ marginTop: 14 }}><a href="#" onClick={(e) => { e.preventDefault(); setSent(false); setCode(''); setMsg(''); }}>Use a different email</a></p>
          </form>
        )}
      </div></div>
    </div>
  );
}
