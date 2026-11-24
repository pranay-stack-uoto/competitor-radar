import Link from 'next/link';
import { Logo } from './components';

export const CONTACT = 'pranayfifa@gmail.com';
import { LEGAL_UPDATED } from '@/lib/legal-version';
export const UPDATED = LEGAL_UPDATED;

export function LegalPage({ title, children }) {
  return (
    <>
      <div className="nav"><div className="nav-in"><Link href="/dashboard" className="brand"><Logo />Competitor Radar</Link></div></div>
      <div className="wrap" style={{ maxWidth: 760 }}>
        <h1>{title}</h1>
        <div className="sub" style={{ marginBottom: 22 }}>Last updated {UPDATED}</div>
        <div className="legal">{children}</div>
        <p className="sub" style={{ marginTop: 28 }}><Link href="/privacy">Privacy Policy</Link> · <Link href="/terms">Terms of Service</Link></p>
      </div>
    </>
  );
}
