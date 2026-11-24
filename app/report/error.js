'use client';
import Link from 'next/link';
import { Nav } from '../components';

export default function Error({ error, reset }) {
  return (
    <>
      <Nav right={<Link className="btn ghost small" href="/dashboard">Back</Link>} />
      <div className="wrap"><div className="card empty">
        <h2>Something went wrong on this page</h2>
        <p className="sub">Your data is safe. Try again, and if it keeps happening, send the message below to support.</p>
        <p><code>{String(error?.message || error).slice(0, 200)}</code></p>
        <button onClick={() => reset()}>Try again</button>
      </div></div>
    </>
  );
}
