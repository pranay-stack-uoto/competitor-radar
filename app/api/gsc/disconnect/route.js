import { NextResponse } from 'next/server';
import { admin } from '@/lib/db';
import { route, requireUser, requireProject, limit } from '@/lib/http';
import { readJsonBody } from '@/lib/security/validate';
import { decrypt, revoke } from '@/lib/gsc';

export const POST = route(async (req) => {
  const auth = await requireUser(req);
  const body = await readJsonBody(req);
  const p = await requireProject(auth, body.projectId, 'id', 'admin');
  await limit(auth, 'gsc');
  const db = admin();
  const { data: tok } = await db.from('gsc_tokens').select('token_enc').eq('project_id', p.id).maybeSingle();
  if (tok) { try { await revoke(decrypt(tok.token_enc, process.env, p.id)); } catch {} } // best effort: the local copy is deleted either way
  await db.from('gsc_tokens').delete().eq('project_id', p.id);
  await db.from('gsc_connections').delete().eq('project_id', p.id);
  await db.from('gsc_snapshots').delete().eq('project_id', p.id);
  return NextResponse.json({ ok: true });
});
