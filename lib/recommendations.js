// Turns weak checks into concrete, prioritised actions. Pure functions: usable on the dashboard and in the report.

export const AREAS = {
  seo: { label: 'SEO content', blurb: 'How well your pages are built for Google to read and rank.' },
  geo: { label: 'AI visibility (GEO)', blurb: 'How easily AI assistants can find, understand and recommend you.' },
  local: { label: 'Local search', blurb: 'How clearly you show up for customers searching in your cities.' },
  keywords: { label: 'Keywords', blurb: 'How well your pages target the phrases customers actually search.' },
};
import { WEIGHTS as SCORING_WEIGHTS } from './scoring/config.js';
export const WEIGHTS = SCORING_WEIGHTS; // defined once, in lib/scoring/config.js

// effort: 1 = under an hour, 2 = a few hours, 3 = days. Matched against the check name.
const PLAYBOOK = [
  { re: /^Title tags/, area: 'seo', effort: 1, title: 'Fix page titles', why: 'The title is the biggest on-page ranking signal and the headline people click in search results.', how: (c) => ['Give every page a unique title of 30 to 65 characters.', `Put the main product or service and the place first, brand last, for example: "${c.kw} ${c.city ? 'in ' + c.city + ' ' : ''}| ${c.brand}".`, 'Fix pages with missing or truncated titles first, starting with your most important pages.'] },
  { re: /^Unique titles/, area: 'seo', effort: 1, title: 'Remove duplicate titles', why: 'Duplicate titles make pages compete with each other and confuse search engines.', how: ['Export your page titles and sort to find repeats.', 'Rewrite each to describe that page specifically.'] },
  { re: /^Meta descriptions/, area: 'seo', effort: 1, title: 'Write meta descriptions', why: 'Descriptions do not rank, but they decide whether people click your result.', how: (c) => ['Write 70 to 160 characters per page naming what the page offers, the place and a reason to choose you.', 'Include a call to action such as "Get a free quote" or "Shop now".'] },
  { re: /^Exactly one H1/, area: 'seo', effort: 1, title: 'Use one clear H1 per page', why: 'The H1 tells Google and visitors what the page is about.', how: ['Make each page have exactly one H1 that names the service and place.', 'Use H2 and H3 for the sections below it.'] },
  { re: /^Subheadings/, area: 'seo', effort: 2, title: 'Add structured subheadings', why: 'Headings make pages scannable and give search engines topic signals.', how: ['Break long pages into sections with descriptive H2 headings.', 'Phrase some as questions customers ask.'] },
  { re: /^Content depth/, area: 'seo', effort: 3, title: 'Deepen your service pages', why: 'Thin pages rarely outrank detailed ones. Competitors with richer pages win the same searches.', how: ['Expand each key service page to 600 to 1,500 words.', 'Add what customers need to decide: what is included, how it works, options, pricing guidance, photos and proof such as reviews or case studies.'] },
  { re: /^Image alt/, area: 'seo', effort: 2, title: 'Add alt text to images', why: 'Alt text helps image search, accessibility and context for AI systems.', how: (c) => [`Describe each image in plain words, for example: "${c.kw}${c.city ? ', ' + c.city : ''}" plus what the photo actually shows.`, 'Start with images on your main product, service and project pages.'] },
  { re: /^Canonical/, area: 'seo', effort: 1, title: 'Add canonical tags', why: 'Canonicals stop duplicate URLs from splitting your ranking.', how: ['Add a canonical link in the head of every page pointing to its preferred URL.'] },
  { re: /^Mobile viewport/, area: 'seo', effort: 1, title: 'Make pages mobile-ready', why: 'Google ranks the mobile version of your site first.', how: ['Add a responsive viewport meta tag and check layouts on a phone.'] },
  { re: /^HTTPS/, area: 'seo', effort: 1, title: 'Serve every page over HTTPS', why: 'HTTPS is a ranking signal and browsers warn visitors on insecure pages.', how: ['Force HTTPS and fix mixed-content links.'] },
  { re: /^Open Graph/, area: 'seo', effort: 1, title: 'Add social preview tags', why: 'Controls how links look when shared on WhatsApp, LinkedIn and Facebook.', how: ['Add og:title, og:description and og:image to each page.'] },
  { re: /^XML sitemap/, area: 'seo', effort: 1, title: 'Publish an XML sitemap', why: 'A sitemap helps Google find and index all of your pages.', how: ['Generate sitemap.xml, list it in robots.txt and submit it in Google Search Console.'] },
  { re: /^robots\.txt/, area: 'seo', effort: 1, title: 'Add a robots.txt file', why: 'It tells crawlers what to read and points them to your sitemap.', how: ['Create /robots.txt allowing public pages and listing your sitemap URL.'] },
  { re: /^Server response/, area: 'seo', effort: 2, title: 'Speed up your server', why: 'Slow pages lose visitors and rank lower.', how: ['Compress images, enable caching and remove unused scripts.', 'Test with Google PageSpeed Insights and fix the top three items.'] },
  { re: /^Crawl errors/, area: 'seo', effort: 2, title: 'Fix broken pages', why: 'Broken links waste crawl budget and frustrate visitors.', how: ['Find links returning errors and fix or redirect them.'] },
  { re: /^Redirects/, area: 'seo', effort: 1, title: 'Remove redirect chains and loops', why: 'Every extra redirect slows the page and leaks ranking strength. Loops make a page unreachable.', how: ['Point each redirect straight at the final page, so no URL redirects more than once.', 'Update menu, footer and in-content links to use the final URL instead of an old one.', 'Break any loop where two URLs redirect to each other.'] },
  { re: /^Broken internal links/, area: 'seo', effort: 1, title: 'Fix broken internal links', why: 'Links to missing pages send visitors and Google to dead ends, which hurts trust and crawling.', how: ['Open the pages listed in the note and change each broken link to a working page.', 'If a page was removed on purpose, add a 301 redirect to the closest replacement.'] },
  { re: /^Indexable pages/, area: 'seo', effort: 1, title: 'Remove stray noindex tags', why: 'A noindex tag tells Google to drop the page from search. On a page you want customers to find, it is lost traffic.', how: ['Check the pages listed in the note for a noindex robots meta tag or X-Robots-Tag header.', 'Remove it from pages that should rank. Keep it only on thank-you, login and internal pages.', 'Make sure your sitemap lists only pages that return 200 and are indexable.'] },
  { re: /^Orphan pages/, area: 'seo', effort: 2, title: 'Link to orphan pages', why: 'Pages with no internal links are hard for Google to find and get little ranking strength.', how: ['Add links to each orphan page from related service pages, your menu or a hub page.', 'If a page is no longer needed, remove it from the sitemap or redirect it.'] },
  { re: /^Duplicate descriptions/, area: 'seo', effort: 2, title: 'Make each page unique', why: 'Pages that share a description, H1 or text compete with each other and weaken every one of them.', how: ['Give each page its own meta description and H1 that describe that page.', 'Rewrite or merge pages whose text is identical, and add a canonical tag pointing to the one you keep.'] },
  { re: /^Image file size/, area: 'seo', effort: 1, title: 'Shrink heavy images', why: 'Large images are the most common reason pages load slowly, and slow pages rank lower and lose visitors.', how: ['Resize images to the size they are shown at and save them as WebP or compressed JPEG.', 'Aim for under 200 KB per image, and lazy-load images below the fold.'] },

  { re: /^AI crawlers allowed/, area: 'geo', effort: 1, title: 'Let AI crawlers read your site', why: 'If your robots.txt blocks GPTBot, ClaudeBot or PerplexityBot, AI assistants cannot cite you.', how: ['Remove blanket Disallow rules for AI crawlers in robots.txt.', 'Allow GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot and Google-Extended.'] },
  { re: /^llms\.txt/, area: 'geo', effort: 1, title: 'Publish an llms.txt file', why: 'A short guide at /llms.txt gives AI tools a clean summary of who you are and your key pages.', how: ['Create /llms.txt with a one-paragraph company description and links to your main service pages.'] },
  { re: /^Organization schema/, area: 'geo', effort: 2, title: 'Add Organization structured data', why: 'Schema tells search engines and AI exactly who you are, your logo, contact details and profiles.', how: ['Add JSON-LD Organization markup to your homepage: name, URL, logo, phone, address and sameAs links.'] },
  { re: /^Entity links/, area: 'geo', effort: 2, title: 'Connect your brand profiles', why: 'Links to your LinkedIn, Google Business, Facebook and directories confirm you are one real entity.', how: ['Add sameAs links to 4 to 8 official profiles in your Organization schema.', 'Keep your name, address and phone identical on all of them.'] },
  { re: /^FAQ/, area: 'geo', effort: 2, title: 'Add FAQs customers really ask', why: 'AI assistants and Google lift direct answers from clear question-and-answer content.', how: ['Add 5 to 8 FAQs to each key page covering what customers ask before buying: price, delivery or timeline, how it works, returns or warranty.', 'Use the question as a heading, then answer in 2 to 3 sentences.'] },
  { re: /^FAQPage/, area: 'geo', effort: 1, title: 'Mark up FAQs with schema', why: 'FAQ schema makes your answers eligible for rich results and easier for AI to quote.', how: ['Add FAQPage JSON-LD that matches the visible questions on each page.'] },
  { re: /^Article/, area: 'geo', effort: 2, title: 'Show authors and dates', why: 'Named authors and publication dates build trust signals that AI systems weigh.', how: ['Publish articles with a named expert author, bio and updated date.'] },
  { re: /^Structured, scannable/, area: 'geo', effort: 2, title: 'Make pages scannable', why: 'Clearly structured pages are easier for both readers and AI to summarise correctly.', how: ['Use short paragraphs, lists, tables and 3+ descriptive subheadings per page.'] },
  { re: /^Substantive content/, area: 'geo', effort: 3, title: 'Replace thin pages with substance', why: 'Pages under 400 words rarely get cited as sources.', how: ['Expand or merge thin pages so each covers one topic properly.'] },

  { re: /^LocalBusiness schema/, area: 'local', effort: 2, title: 'Add LocalBusiness schema', why: 'It tells Google your business type, address, hours and service areas, which feeds local results.', how: ['Add LocalBusiness JSON-LD to the homepage and each office page: address, phone, hours, geo coordinates.'] },
  { re: /^Schema has address/, area: 'local', effort: 1, title: 'Complete your address and service area data', why: 'Missing address or areaServed fields weaken local relevance.', how: ['Add a full postal address, geo coordinates and areaServed (every city you serve) to your schema.'] },
  { re: /^Phone number/, area: 'local', effort: 1, title: 'Show a click-to-call number', why: 'A visible phone number is a core local trust signal and a conversion driver.', how: ['Put your number in the header and footer of every page as a tel: link.'] },
  { re: /^Street address/, area: 'local', effort: 1, title: 'Publish your full address', why: 'Consistent name, address and phone (NAP) text is a local ranking factor.', how: ['Show the full address in the footer and on the contact page, matching your Google Business Profile exactly.'] },
  { re: /^Google Maps embed/, area: 'local', effort: 1, title: 'Embed a Google Map', why: 'Reinforces your location and helps visitors find you.', how: ['Embed a Google Map for each office on the contact page.'] },
  { re: /^Review/, area: 'local', effort: 2, title: 'Add reviews and ratings', why: 'Reviews are among the strongest local ranking and conversion signals.', how: ['Ask recent customers for Google reviews and add testimonials with Review schema to your site.'] },
  { re: /^Location/, area: 'local', effort: 2, title: 'Create a page for each city you serve', why: 'A dedicated page per city is what ranks for "[what you offer] in [city]" searches.', how: ['Build one page per city with local projects, clients and the services you offer there.', 'Avoid copy-paste: include real local detail on each.'] },
  { re: /^Target locations in content/, area: 'local', effort: 2, title: 'Mention your service cities in your content', why: 'Search engines connect you to a place by what your pages say.', how: ['Reference the cities you serve naturally in service pages, project write-ups and your footer.'] },
  { re: /^Target locations in titles/, area: 'local', effort: 1, title: 'Put cities in titles and headings', why: 'City names in titles and H1s are a direct signal for local queries.', how: ['Add the city to the title and H1 of each city or service page.'] },

  { re: /^Coverage:/, area: 'keywords', effort: 2, title: null, why: null, how: null, dynamic: 'coverage' },
  { re: /^Google position:/, area: 'keywords', effort: 3, title: null, why: null, how: null, dynamic: 'position' },
];

function keywordOf(name) { const m = name.match(/"(.+)"/); return m ? m[1] : name; }

export function buildActions(me, benchmarks = {}, context = {}) {
  const ctx = { kw: context.keywords?.[0] || 'your main product or service', city: context.locations?.[0] || '', brand: context.brand || 'Brand' };
  // me: details object for your site. benchmarks[area][checkName] = best competitor value (0..1)
  const out = [];
  for (const area of Object.keys(AREAS)) {
    const d = me?.[area];
    if (!d?.checks) continue;
    const live = d.checks.filter((c) => c.value != null);
    const wsum = live.reduce((s, c) => s + c.weight, 0) || 1;
    for (const c of live) {
      if (c.value >= 0.85) continue; // already strong
      const rule = PLAYBOOK.find((p) => p.re.test(c.name));
      if (!rule) continue;
      const best = benchmarks[area]?.[c.name];
      const areaGain = (c.weight / wsum) * (1 - c.value) * 100;      // points on the sector score
      const overallGain = areaGain * (WEIGHTS[area] / 1);             // points on the overall score
      let title = rule.title, why = rule.why, how = typeof rule.how === 'function' ? rule.how(ctx) : rule.how;
      if (rule.dynamic === 'coverage') {
        const kw = keywordOf(c.name);
        title = `Create a dedicated page for "${kw}"`;
        why = `Only ${Math.round(c.value * 100)}% of the ways a page can target this phrase are covered. Pages built around one phrase outrank pages that mention it in passing.`;
        how = [`Build or rewrite one page whose title and H1 contain "${kw}" and the city.`, 'Add 600+ words covering what you do, process, projects and FAQs for this service.', 'Link to it from your homepage and related service pages.'];
      } else if (rule.dynamic === 'position') {
        const kw = keywordOf(c.name);
        title = `Move up on Google for "${kw}"`;
        why = `${/^#\d+/.test(c.note) ? `You currently rank ${c.note}` : 'You do not appear in the top 20 Google results'} for this search. Page-one positions get most of the clicks.`;
        how = ['Strengthen the dedicated page for this phrase (see the coverage action).', 'Earn 3 to 5 relevant backlinks: local and industry sites, suppliers and partners, and features about your customers or products.', 'Add this phrase and city to your Google Business Profile services and posts.'];
      }
      out.push({
        area, check: c.name, title, why, how, effort: rule.effort,
        current: Math.round(c.value * 100), best: best != null ? Math.round(best * 100) : null,
        note: c.note || '', gain: Math.round(overallGain * 10) / 10, areaGain: Math.round(areaGain * 10) / 10,
        priority: overallGain / rule.effort + (best != null && best - c.value > 0.2 ? 0.5 : 0),
      });
    }
  }
  return out.sort((a, b) => b.priority - a.priority);
}

export const EFFORT = { 1: 'Under 1 hour', 2: 'A few hours', 3: 'Several days' };

// Group into a 4-week plan: quick wins first, bigger builds later.
export function buildPlan(actions) {
  const week = [[], [], [], []];
  const sorted = [...actions];
  sorted.filter((a) => a.effort === 1).forEach((a, i) => week[i < 6 ? 0 : 1].push(a));
  sorted.filter((a) => a.effort === 2).forEach((a, i) => week[i < 5 ? 1 : 2].push(a));
  sorted.filter((a) => a.effort === 3).forEach((a, i) => week[i < 3 ? 2 : 3].push(a));
  return week;
}

export function sectorSummary(area, mine, best, avg) {
  const gap = Math.round((best - mine) * 10) / 10;
  if (mine >= best) return `You lead this area. Protect it by keeping content fresh.`;
  if (gap <= 5) return `You are close to the best competitor (${gap} points behind). Small fixes will close the gap.`;
  if (gap <= 15) return `You trail the best competitor by ${gap} points. The actions below are your fastest way to catch up.`;
  return `You trail the best competitor by ${gap} points. This is your biggest opportunity.`;
}

// The playbook entry for a check, used to turn "a competitor improved X" into "here is how you copy it".
export function lessonFor(checkName) {
  const r = PLAYBOOK.find((p) => p.re.test(checkName));
  return r && r.title ? { title: r.title, why: r.why } : null;
}
