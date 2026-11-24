'use client';
import { useEffect } from 'react';
import { sb } from '@/lib/supabase-browser';

export default function Home() {
  useEffect(() => {
    sb().auth.getSession().then(({ data }) => { window.location.href = data.session ? '/dashboard' : '/welcome'; });
  }, []);
  return <main><p className="sub">Loading…</p></main>;
}
