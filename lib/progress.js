// Progress of one refresh ("Crawl now"), from the project's jobs created since the click. PURE.
// Phases: the Google/Maps step (a discovery job), then one crawl job per site, then the report. Percentages are honest about what is known:
// the number of crawl jobs is only known once discovery has finished, so that step is shown as the first 10%.
const finished = (j) => j.status === 'done' || j.status === 'failed';

function progressOf(jobs, now = Date.now()) {
  const discover = jobs.filter((j) => j.kind === 'discover'), crawl = jobs.filter((j) => j.kind === 'crawl');
  if (!discover.length && !crawl.length) return { phase: 'starting', percent: 3, done: 0, total: 0, etaSeconds: null, complete: false };
  const discoverDone = discover.length > 0 && discover.every(finished);
  if (!discoverDone && !crawl.length) return { phase: 'searching', percent: 8, done: 0, total: 0, etaSeconds: 90, complete: false };
  const done = crawl.filter(finished).length, total = crawl.length;
  if (!total) return { phase: 'done', percent: 100, done: 0, total: 0, etaSeconds: 0, complete: true };
  const allDone = done === total && discoverDone;
  // Time left: the observed pace of this refresh once at least one site has finished, else 45 s a site shared by two workers.
  let eta = Math.round(((total - done) * 45) / 2);
  const starts = crawl.map((j) => Date.parse(j.started_at)).filter(Number.isFinite);
  if (done > 0 && starts.length) {
    const elapsed = (now - Math.min(...starts)) / 1000;
    if (elapsed > 5) eta = Math.round(((total - done) * elapsed) / done);
  }
  return { phase: allDone ? 'done' : 'crawling', percent: allDone ? 100 : Math.min(99, Math.round(10 + (90 * done) / total)), done, total, etaSeconds: allDone ? 0 : Math.min(eta, 3600), complete: allDone };
}

// "about 6 min left", "under a minute left"
function etaText(seconds) {
  if (seconds === null || seconds === undefined) return '';
  if (seconds < 60) return 'under a minute left';
  const m = Math.round(seconds / 60);
  return `about ${m} min left`;
}

module.exports = { progressOf, etaText };
