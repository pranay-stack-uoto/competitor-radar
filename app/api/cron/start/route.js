import { NextResponse } from 'next/server';
import { authorizedCron, kickWorker } from '@/lib/db';
import { startDay } from '@/lib/pipeline';

export const maxDuration = 60;

// 09:00 IST (03:30 UTC): queue discovery for every project, then hand off to the worker.
export async function GET(req) {
  if (!authorizedCron(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const r = await startDay();
  await kickWorker().done;
  return NextResponse.json(r);
}
