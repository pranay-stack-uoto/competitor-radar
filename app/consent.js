'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { sb } from '@/lib/supabase-browser';
import { LEGAL_VERSION } from '@/lib/legal-version';

// Records acceptance of the current Terms and Privacy Policy. People who ticked the box on the sign-in page are recorded automatically; anyone
// without a record for this version (existing users, or after the documents changed) must accept before carrying on.
export const CONSENT_FLAG = 'radar-accepted-legal';
const DOCS = ['terms', 'privacy'];

async function record() {
  const { error } = await sb().from('legal_consents').upsert(DOCS.map((doc) => ({ doc, version: LEGAL_VERSION })), { onConflict: 'user_id,doc,version', ignoreDuplicates: true });
  return !error;
}

export function ConsentGate() {
  const [state, setState] = useState('checking'); // checking | ok | needed
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const { data: s } = await sb().auth.getSession();
        if (!s.session) return setState('ok');
        const { data } = await sb().from('legal_consents').select('doc').eq('version', LEGAL_VERSION);
        if (DOCS.every((d) => (data || []).some((r) => r.doc === d))) return setState('ok');
        let pre = false; try { pre = localStorage.getItem(CONSENT_FLAG) === LEGAL_VERSION; } catch {}
        if (pre && await record()) { try { localStorage.removeItem(CONSENT_FLAG); } catch {} return setState('ok'); }
        setState('needed');
      } catch { setState('ok'); } // never lock people out because the check itself failed; the next page load asks again
    })();
  }, []);
  if (state !== 'needed') return null;
  async function accept() { setBusy(true); if (await record()) setState('ok'); setBusy(false); }
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,.6)', display: 'grid', placeItems: 'center', padding: 16 }} role="dialog" aria-modal="true" aria-labelledby="consent-t">
      <div className="card pad" style={{ maxWidth: 460 }}>
        <h2 id="consent-t">Please accept our terms to continue</h2>
        <p className="sub" style={{ margin: '8px 0 14px' }}>We have a Terms of Service and a Privacy Policy (version {LEGAL_VERSION}). Read them, then accept to keep using Competitor Radar.</p>
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 14 }}>
          <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} style={{ marginTop: 3 }} />
          <span>I have read and agree to the <Link href="/terms" target="_blank">Terms of Service</Link> and the <Link href="/privacy" target="_blank">Privacy Policy</Link>.</span>
        </label>
        <button disabled={!ticked || busy} onClick={accept} style={{ marginTop: 16, width: '100%', justifyContent: 'center' }}>{busy ? 'Saving…' : 'Accept and continue'}</button>
      </div>
    </div>
  );
}
