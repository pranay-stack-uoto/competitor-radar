// Switches an organisation's plan by hand (until a payment gateway is connected). Uses the service role; run it only from your own machine.
//   node scripts/set-plan.mjs list
//   node scripts/set-plan.mjs set <organisation-id> active --until 2027-01-31
//   node scripts/set-plan.mjs set <organisation-id> trial --runs 20 --days 14      (extend or reset a trial's limits)
//   node scripts/set-plan.mjs set <organisation-id> cancelled
// Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local. Never prints keys.
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

try { for (const l of readFileSync('.env.local', 'utf8').split('\n')) { const i = l.indexOf('='); if (i > 0 && !l.startsWith('#') && !process.env[l.slice(0, i).trim()]) process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, ''); } } catch {}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const [cmd, org, plan, ...rest] = process.argv.slice(2);
const flag = (n) => { const i = rest.indexOf('--' + n); return i >= 0 ? rest[i + 1] : undefined; };

if (cmd === 'list') {
  const { data, error } = await db.from('organisations').select('id,name,plan,plan_until,trial_runs_used,trial_runs_limit,trial_ends_at').order('created_at');
  if (error) { console.error('Could not read organisations.'); process.exit(1); }
  console.table(data.map((o) => ({ id: o.id, name: o.name, plan: o.plan, until: o.plan_until?.slice(0, 10) || '', runs: `${o.trial_runs_used}/${o.trial_runs_limit}`, trial_ends: o.trial_ends_at?.slice(0, 10) })));
} else if (cmd === 'set' && org && plan) {
  const until = flag('until');
  const { data, error } = await db.rpc('org_set_plan', { p_org: org, p_plan: plan, p_until: until ? new Date(until + 'T23:59:59Z').toISOString() : null, p_trial_runs: flag('runs') ? Number(flag('runs')) : null, p_trial_days: flag('days') ? Number(flag('days')) : null });
  if (error) { console.error('Failed:', error.message); process.exit(1); }
  console.log(data);
} else { console.error('Usage: see the comment at the top of this file.'); process.exit(2); }
