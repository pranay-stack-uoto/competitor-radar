// robots.txt parsing, kept separate from the crawler so scoring code can use it without any network dependency.
function parseRobots(txt) {
  // returns { groups: {agent: [{allow:boolean,path}]}, sitemaps: [] }
  const groups = {};
  const sitemaps = [];
  let cur = [];
  let lastWasAgent = false;
  for (const raw of String(txt || '').split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (k === 'user-agent') {
      if (!lastWasAgent) cur = [];
      cur.push(v.toLowerCase());
      groups[v.toLowerCase()] = groups[v.toLowerCase()] || [];
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (k === 'sitemap') sitemaps.push(v);
      else if (k === 'allow' || k === 'disallow') for (const a of cur) groups[a].push({ allow: k === 'allow', path: v });
    }
  }
  return { groups, sitemaps };
}

// Is the whole site blocked for this agent? (Disallow: / with no broader allow)
function agentBlocked(robots, agent) {
  const rules = robots.groups[agent.toLowerCase()] || (robots.groups['*'] ? robots.groups['*'] : null);
  if (!rules) return false;
  const dis = rules.some((r) => !r.allow && r.path === '/');
  const allowRoot = rules.some((r) => r.allow && (r.path === '/' || r.path === ''));
  return dis && !allowRoot;
}

// The crawlers that matter for search and AI answers. kind: search (lists you in results), user (fetches a page a person asked about),
// training (collects text to train models; blocking it does not affect being cited in answers).
const AI_BOTS = [
  { bot: 'Googlebot', label: 'Google Search', kind: 'search' },
  { bot: 'Google-Extended', label: 'Google AI training (Gemini)', kind: 'training' },
  { bot: 'OAI-SearchBot', label: 'ChatGPT Search', kind: 'search' },
  { bot: 'ChatGPT-User', label: 'ChatGPT browsing for a user', kind: 'user' },
  { bot: 'GPTBot', label: 'OpenAI training', kind: 'training' },
  { bot: 'Claude-SearchBot', label: 'Claude search', kind: 'search' },
  { bot: 'Claude-User', label: 'Claude browsing for a user', kind: 'user' },
  { bot: 'ClaudeBot', label: 'Anthropic training', kind: 'training' },
  { bot: 'PerplexityBot', label: 'Perplexity search', kind: 'search' },
  { bot: 'Perplexity-User', label: 'Perplexity browsing for a user', kind: 'user' },
  { bot: 'Applebot', label: 'Apple (Siri, Spotlight)', kind: 'search' },
  { bot: 'Applebot-Extended', label: 'Apple AI training', kind: 'training' },
  { bot: 'Amazonbot', label: 'Amazon (Alexa)', kind: 'search' },
  { bot: 'Bingbot', label: 'Bing (also feeds Copilot)', kind: 'search' },
  { bot: 'CCBot', label: 'Common Crawl (used to train many models)', kind: 'training' },
];
// Which of them may read the home page. A bot with its own group follows it; otherwise the "*" group applies. No robots.txt means everyone is allowed.
function aiBotAccess(robots) {
  const r = robots && robots.groups ? robots : parseRobots('');
  return AI_BOTS.map((b) => ({ ...b, allowed: !agentBlocked(r, b.bot) }));
}

module.exports = { parseRobots, agentBlocked, aiBotAccess, AI_BOTS };
