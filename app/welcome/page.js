import Link from 'next/link';
import { Logo } from '../components';

export const metadata = {
  title: 'Competitor Radar: see who beats you online and what to fix',
  description: 'Competitor Radar finds the businesses competing with you on Google and AI assistants, scores every site daily, and lists exactly what to fix first.',
};

// Hero radar. You are the centre. A rival sits further out the further behind you it is (40 points = the outer ring).
const SWEEP_SECONDS = 8;
const YOU = { site: 'yourbrand.in', score: 70.8 };
const RIVALS = [
  { site: 'rival-one.com', score: 56.8, angle: 48 },
  { site: 'rival-two.in', score: 48.8, angle: 128 },
  { site: 'rival-three.com', score: 48.5, angle: 214 },
  { site: 'rival-four.com', score: 43.3, angle: 268 },
  { site: 'rival-five.net', score: 40.7, angle: 322 },
].map((r) => {
  const dist = (YOU.score - r.score) / 40;
  const rad = (r.angle * Math.PI) / 180;
  return { ...r, x: 50 + dist * 50 * Math.sin(rad), y: 50 - dist * 50 * Math.cos(rad), delay: (r.angle / 360) * SWEEP_SECONDS };
});
const TICKS = Array.from({ length: 36 }, (_, i) => i * 10);

// Trend chart for the product preview.
const DAYS = 14;
const SERIES = [
  { name: 'yourbrand.in', cls: 'you', v: [64.2, 64.9, 65.0, 66.1, 66.4, 67.0, 67.2, 68.3, 68.1, 69.0, 69.4, 70.0, 70.2, 70.8] },
  { name: 'rival-one.com', cls: 'r1', v: [56.0, 56.1, 56.3, 56.2, 56.5, 56.4, 56.6, 56.5, 56.7, 56.8, 56.8, 56.9, 56.8, 56.8] },
  { name: 'rival-two.in', cls: 'r2', v: [51.5, 51.0, 50.6, 50.2, 50.0, 49.6, 49.5, 49.2, 49.0, 48.9, 48.8, 48.8, 48.8, 48.8] },
];
const CW = 560, CH = 190, PAD = 14;
const px = (i) => PAD + (i / (DAYS - 1)) * (CW - PAD * 2);
const py = (v) => CH - PAD - ((v - 46) / (74 - 46)) * (CH - PAD * 2);
const line = (v) => v.map((n, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${py(n).toFixed(1)}`).join(' ');
const area = (v) => `${line(v)} L${px(DAYS - 1)} ${CH - PAD} L${px(0)} ${CH - PAD} Z`;
const SPARK = [12, 14, 13, 17, 16, 21, 20, 25, 24, 29, 28, 34];
const spark = SPARK.map((n, i) => `${i ? 'L' : 'M'}${(i / (SPARK.length - 1)) * 120} ${40 - n}`).join(' ');

const LEADERS = [
  { site: 'yourbrand.in', you: true, overall: 70.8, d: '+1.8' },
  { site: 'rival-one.com', overall: 56.8, d: '0.0' },
  { site: 'rival-two.in', overall: 48.8, d: '0.0' },
  { site: 'rival-three.com', overall: 48.5, d: '-3.7' },
];

const STATS = [['45+', 'checks on every site'], ['4', 'scored areas'], ['Daily', 'scans at 9:00 IST'], ['Read-only', 'access to your site']];

const STEPS = [
  { t: 'Add your website', d: 'Prove it is yours with a small file or DNS record. We read your pages and suggest the keywords and cities you should be found for.' },
  { t: 'We map your competitors', d: 'Google results, Google Maps and well-known industry names are checked for your keywords and cities. Remove any site, or add one yourself.' },
  { t: 'Everyone is scored daily', d: 'Each morning every site is read and scored. Your leaderboard, overnight changes and prioritised fix list are ready by 10:00 IST.' },
];

const SOON = [
  { t: 'Live AI answer tracking', d: 'Ask AI assistants your customers’ questions and see who they recommend.' },
  { t: 'One-click fixes', d: 'Approve a change and we apply it to Cloudflare, WordPress, Shopify or Wix, with undo.' },
  { t: 'Digest and alerts', d: 'The morning summary by email, big competitor moves on WhatsApp.' },
  { t: 'Teams and agencies', d: 'Client logins, white-label reports and an API.' },
];

const PLANS = [
  { name: 'Free', price: '0', blurb: 'See where you stand.', cta: 'Start free', items: ['1 site, 3 competitors', 'Weekly scan', 'Scores and leaderboard', 'Top 3 fixes', 'Search Console data', '30 days of history'], soon: ['5 AI visibility tests a month'] },
  { name: 'Starter', price: '999', blurb: 'One business that wants to climb.', cta: 'Get early access', items: ['1 site, 5 competitors', 'Daily scan and full-site audit', 'Every fix, with effect tracking', 'Full report and AI brief', '6 months of history'], soon: ['Email digest', 'AI visibility: 10 questions, 2 engines, weekly'] },
  { name: 'Growth', price: '2,999', blurb: 'Several sites or service lines.', cta: 'Get early access', featured: true, items: ['3 sites, 10 competitors each', 'Everything in Starter', '2 years of history', '3 team seats'], soon: ['AI visibility: 25 questions, 4 engines, weekly', 'One-click fixes', 'WhatsApp alerts'] },
  { name: 'Agency', price: '9,999', blurb: 'Agencies running client sites.', cta: 'Get early access', items: ['10 sites, 10 competitors each', 'Everything in Growth', '10 seats, unlimited history'], soon: ['Client logins', 'White-label PDF reports', 'API access', 'Daily AI checks on priority questions'] },
];

const FAQ = [
  { q: 'Does Competitor Radar change my website?', a: 'No. Today it only reads your public pages and, if you connect it, your Search Console data in read-only mode. When one-click fixes arrive, nothing is changed without your approval, and every change can be undone.' },
  { q: 'How are the scores worked out?', a: 'Each area is a list of checks, such as title length, schema markup, a phone number on the page, or whether AI crawlers are allowed. The checks are weighted and combined into a score out of 100. Every site is measured the same way, so the comparison is fair.' },
  { q: 'How do you find my competitors?', a: 'From Google results for your keywords in your cities, from Google Maps, and from well-known names in your industry. Sites that are not real competitors can be removed with one click, and you can add any site yourself.' },
  { q: 'Where is my data kept?', a: 'In a database in Mumbai. Search Console access tokens are encrypted. We do not sell data. The privacy page has the details.' },
  { q: 'Can I pay for a plan today?', a: 'Not yet. Billing is not switched on. Everyone is on the free beta while plans are in preview, and the prices above may change before launch.' },
];

export default function Welcome() {
  return (
    <div className="lp">
      <header className="lp-nav">
        <div className="lp-in lp-navrow">
          <Link href="/welcome" className="brand"><Logo /><span className="brand-t">Competitor Radar</span></Link>
          <nav className="lp-links" aria-label="Sections">
            <a href="#product">Product</a><a href="#how">How it works</a><a href="#plans">Plans</a><a href="#faq">Questions</a>
          </nav>
          <div className="lp-navcta"><Link href="/login" className="lp-signin">Sign in</Link><Link href="/login" className="btn small">Start free</Link></div>
        </div>
      </header>

      <section className="lp-hero">
        <div className="lp-in lp-herogrid">
          <div className="lp-copy">
            <div className="lp-eyebrow"><i />Competitive intelligence for local and service businesses</div>
            <h1>Your competitors, on radar. <span>Every single day.</span></h1>
            <p className="lp-lede">Competitor Radar scores your site against every business competing for your customers on Google and AI assistants, then tells you exactly what to fix first.</p>
            <div className="lp-cta">
              <Link href="/login" className="btn lp-btn">Start free</Link>
              <a href="#product" className="btn ghost lp-btn">See the product</a>
            </div>
            <div className="lp-fine">Sign in with an email code. No card needed.</div>
          </div>

          <div className="lp-radar" role="img" aria-label="Radar showing yourbrand.in at the centre and five competitors, placed further out the further behind you they are">
            <svg viewBox="0 0 100 100" className="lp-scope" aria-hidden="true">
              {[25, 50, 75, 100].map((r) => <circle key={r} cx="50" cy="50" r={r / 2 - 0.4} className="ring" />)}
              <line x1="50" y1="0" x2="50" y2="100" className="axis" /><line x1="0" y1="50" x2="100" y2="50" className="axis" />
              {TICKS.map((a) => {
                const rad = (a * Math.PI) / 180, long = a % 90 === 0 ? 3.2 : a % 30 === 0 ? 2.2 : 1.2;
                return <line key={a} x1={50 + 49.6 * Math.sin(rad)} y1={50 - 49.6 * Math.cos(rad)} x2={50 + (49.6 - long) * Math.sin(rad)} y2={50 - (49.6 - long) * Math.cos(rad)} className="tick" />;
              })}
              {[['10', 12.5], ['20', 25], ['30', 37.5], ['40', 50]].map(([l, r]) => <text key={l} x="51" y={50 - r + 2.6} className="rl">{l}</text>)}
            </svg>
            <div className="lp-sweep" style={{ '--t': SWEEP_SECONDS + 's' }} />
            <div className="lp-you"><i /><span>{YOU.site} <b>{YOU.score}</b></span></div>
            {RIVALS.map((r) => (
              <div className={'lp-blip' + (r.x > 62 ? ' flip' : '')} key={r.site} style={{ left: r.x + '%', top: r.y + '%', '--t': SWEEP_SECONDS + 's', '--d': r.delay.toFixed(2) + 's' }}>
                <i /><span>{r.site} <b>{r.score}</b></span>
              </div>
            ))}
            <div className="lp-scale">Distance from centre = points behind you</div>
          </div>
        </div>

        <div className="lp-in lp-stats">
          {STATS.map(([v, l]) => <div key={l}><b>{v}</b><span>{l}</span></div>)}
        </div>
      </section>

      <section id="product" className="lp-in lp-sec">
        <div className="lp-head"><div className="lp-tag">The product</div><h2>One screen for the whole market.</h2><p className="lp-sub">Your rank, your trend and every competitor’s, updated each morning. The numbers below are example data.</p></div>
        <div className="lp-window">
          <div className="lp-chrome"><i /><i /><i /><span>competitor-radar / overview</span></div>
          <div className="lp-wbody">
            <div className="lp-wl">
              <div className="lp-wtop">
                <div><div className="lp-k">Your rank</div><div className="lp-big">#1 <small>of 12 sites</small></div></div>
                <div><div className="lp-k">Overall score</div><div className="lp-big">70.8 <em>▲ 1.8</em></div></div>
              </div>
              <svg viewBox={`0 0 ${CW} ${CH}`} className="lp-chart" aria-label="Overall score trend over 14 days">
                {[50, 58, 66, 74].map((g) => <line key={g} x1={PAD} x2={CW - PAD} y1={py(g)} y2={py(g)} className="grid" />)}
                <path d={area(SERIES[0].v)} className="fillyou" />
                {SERIES.slice().reverse().map((s) => <path key={s.name} d={line(s.v)} pathLength="1" className={'ln ' + s.cls} />)}
                <circle cx={px(DAYS - 1)} cy={py(70.8)} r="4.5" className="endpt" />
              </svg>
              <div className="lp-legend">{SERIES.map((s) => <span key={s.name} className={s.cls}>{s.name}</span>)}</div>
            </div>
            <div className="lp-wr">
              <div className="lp-k">Leaderboard</div>
              {LEADERS.map((r, i) => (
                <div className={'lp-lrow' + (r.you ? ' me' : '')} key={r.site}>
                  <span className="n">{i + 1}</span><span className="s">{r.site}</span>
                  <span className="b"><i style={{ width: r.overall + '%', animationDelay: i * 120 + 'ms' }} /></span>
                  <b>{r.overall}</b>
                </div>
              ))}
              <div className="lp-k" style={{ marginTop: 18 }}>Areas</div>
              {[['SEO content', 86, 'seo'], ['AI visibility', 72, 'geo'], ['Local search', 77, 'local'], ['Keywords', 47, 'kw']].map(([l, v, c]) => (
                <div className="lp-area" key={l}><span>{l}</span><span className="b"><i className={c} style={{ width: v + '%' }} /></span><b>{v}</b></div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section id="features" className="lp-in lp-sec">
        <div className="lp-head"><div className="lp-tag">What you get today</div><h2>Everything you need to out-rank the market.</h2><p className="lp-sub">These features are live. Illustrations use example data.</p></div>
        <div className="lp-bento">
          <div className="lp-cell c7">
            <h3>Daily scores</h3><p>SEO content, AI visibility, local search and keywords for you and every competitor, measured the same way.</p>
            <div className="lp-mini">{[['SEO content', 86, 'seo'], ['AI visibility', 72, 'geo'], ['Local search', 77, 'local'], ['Keywords', 47, 'kw']].map(([l, v, c]) => <div className="lp-area" key={l}><span>{l}</span><span className="b"><i className={c} style={{ width: v + '%' }} /></span><b>{v}</b></div>)}</div>
          </div>
          <div className="lp-cell c5">
            <h3>What changed overnight</h3><p>See a competitor’s move the next morning, with a note on how to copy it.</p>
            <div className="lp-mini lp-feed">
              <div><em className="up">▲</em><span><b>rival-one.com</b> added FAQ schema</span></div>
              <div><em className="dn">▼</em><span><b>rival-three.com</b> dropped 3.7 points</span></div>
              <div><em className="up">▲</em><span><b>You</b> overtook rival-two.in</span></div>
            </div>
          </div>
          <div className="lp-cell c5">
            <h3>A fix list with proof</h3><p>Ranked by points gained per hour. Mark one done and see whether the score moved.</p>
            <div className="lp-mini lp-fixes">
              <div><span>Add LocalBusiness schema</span><em>+3.1 pts</em></div>
              <div><span>Write two city pages</span><em>+2.4 pts</em></div>
              <div><span>Fix duplicate descriptions</span><em>+0.9 pts</em></div>
            </div>
          </div>
          <div className="lp-cell c7">
            <h3>Full-site audit, every day</h3><p>Every page is read for broken links, redirects, pages nothing links to, duplicates and heading problems.</p>
            <div className="lp-mini lp-audit">
              <div><b>6</b><span>broken links</span></div><div><b>9</b><span>links to redirects</span></div><div><b>17</b><span>orphan pages</span></div><div><b>2</b><span>shared titles</span></div>
            </div>
          </div>
          <div className="lp-cell c6">
            <h3>Your real Google data</h3><p>Connect Search Console, read-only, to see real clicks, positions and queries beside the scores.</p>
            <div className="lp-mini lp-gsc">
              <div><span>Clicks, 28 days</span><b>1,240</b></div>
              <svg viewBox="0 0 120 44" preserveAspectRatio="none" aria-hidden="true"><path d={spark + ' L120 44 L0 44 Z'} className="a" /><path d={spark} className="l" pathLength="1" /></svg>
            </div>
          </div>
          <div className="lp-cell c6">
            <h3>An AI brief you can paste</h3><p>A plain-text brief of your fixes, ready for ChatGPT or Claude to do the work.</p>
            <pre className="lp-code"><code>{`# Fix list for yourbrand.in\n1. Add LocalBusiness schema  (+3.1 pts, 1 hr)\n2. Create city pages for your\n   top 3 cities               (+2.4 pts, 4 hr)\n3. Make meta descriptions unique (+0.9 pts)`}</code></pre>
          </div>
        </div>
        <div className="lp-soonhead">Coming next</div>
        <div className="lp-soon">
          {SOON.map((f) => <div key={f.t}><h3>{f.t}<span>Soon</span></h3><p>{f.d}</p></div>)}
        </div>
      </section>

      <section id="how" className="lp-in lp-sec">
        <div className="lp-head"><div className="lp-tag">How it works</div><h2>From sign-up to your first leaderboard in about 15 minutes.</h2></div>
        <ol className="lp-steps">
          {STEPS.map((s, i) => <li key={s.t}><span>{String(i + 1).padStart(2, '0')}</span><h3>{s.t}</h3><p>{s.d}</p></li>)}
        </ol>
      </section>

      <section id="plans" className="lp-in lp-sec">
        <div className="lp-head"><div className="lp-tag">Plans</div><h2>Simple plans that grow with you.</h2><p className="lp-sub">Prices are per month, before 18% GST. This is a preview. Billing is not on yet, so everyone is on the free beta for now.</p></div>
        <div className="lp-plans">
          {PLANS.map((p) => (
            <div className={'lp-plan' + (p.featured ? ' feat' : '')} key={p.name}>
              <div className="lp-pname">{p.name}{p.featured && <span>Recommended</span>}</div>
              <div className="lp-price"><sup>₹</sup>{p.price}<small>/month</small></div>
              <p className="lp-pblurb">{p.blurb}</p>
              <Link href="/login" className={'btn lp-btn' + (p.featured ? '' : ' ghost')}>{p.cta}</Link>
              <ul>
                {p.items.map((x) => <li key={x}>{x}</li>)}
                {p.soon.map((x) => <li className="soon" key={x}>{x}<span>Soon</span></li>)}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section id="faq" className="lp-in lp-sec lp-faq">
        <div className="lp-head"><div className="lp-tag">Questions</div><h2>Before you start.</h2></div>
        {FAQ.map((f) => <details key={f.q}><summary>{f.q}</summary><p>{f.a}</p></details>)}
      </section>

      <section className="lp-in lp-final">
        <div className="lp-finalcard">
          <div className="lp-finalradar" aria-hidden="true"><div className="lp-sweep" style={{ '--t': '10s' }} /></div>
          <h2>See where you really stand.</h2>
          <p>Add your site and your first leaderboard is ready in about 15 minutes.</p>
          <Link href="/login" className="btn lp-btn">Start free</Link>
        </div>
      </section>

      <footer className="lp-in lp-foot">
        <Link href="/welcome" className="brand"><Logo /><span className="brand-t">Competitor Radar</span></Link>
        <span><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link></span>
      </footer>
    </div>
  );
}
