import { NextResponse, after } from 'next/server';
import { authorizedWorker, kickWorker, admin } from '@/lib/db';
import { workOne, finishProjects } from '@/lib/pipeline';
import { workload, shouldSpawnWorker } from '@/lib/queue';

export const maxDuration = 300;

// Answers at once and works through the job queue in the background. Two things keep the daily run from stalling when one call is cut off by the
// platform's time limit (a slow site once did this and left a whole project uncrawled):
//  1. At the START, if work remains beyond what this call can do, it starts the next worker straight away (at most two jobs run at once), so the
//     chain never depends on this call surviving to its end.
//  2. It stops taking new jobs after 120 s, leaving 180 s for the job in hand, and starts a successor if work remains.
// Answering first matters too: the caller's request is only guaranteed to arrive if it is allowed to finish quickly.
export async function GET(req) {
  if (!authorizedWorker(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  after(async () => {
    const deadline = Date.now() + (maxDuration - 180) * 1000;
    const db = admin();
    try { if (shouldSpawnWorker(await workload(db))) await kickWorker().done; } catch (e) { console.error('worker spawn check failed:', e?.message); }
    let more = true;
    try {
      while (Date.now() < deadline && (more = await workOne())) { /* one job per turn */ }
      if (!more) await finishProjects(); // queue drained: rank and publish any project whose crawls are all done
    } catch (e) { console.error('worker stopped:', e?.message); more = false; } // never re-kick after a failure: that could loop
    try { if (more && shouldSpawnWorker(await workload(db))) await kickWorker().done; } catch { /* the daily report cron is the safety net */ }
  });
  return NextResponse.json({ started: true });
}
