// Logical backup and restore of the application's data. The migrations are the schema of record, so a backup holds DATA only:
// restoring means "apply the migrations to an empty database, then load the data" (scripts/restore-drill.mjs does exactly that and checks the result).
// This complements, and does not replace, Supabase's own backups and pg_dump: it is portable, encrypted, checksummed, and can be restored anywhere.
// It reads whole tables into memory, which is fine for this database today; past about 100 MB use pg_dump (docs/OPERATIONS.md).
//
// Not backed up on purpose (rebuilt automatically): rate_limits, ai_cache, domain_crawls, domain_crawl_snapshots, benchmark_aggregates.
// Backed up: everything customers or auditors would miss, including the audit trail (its hash chain is re-verified after a restore).
// Sign-in accounts (auth.users) are Supabase's: only their ids and emails are listed so restored rows have a place to point to.
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const SKIP = new Set(['rate_limits', 'ai_cache', 'domain_crawls', 'domain_crawl_snapshots', 'benchmark_aggregates', 'oauth_states', 'domain_authority', 'keyword_volumes']);
const MAGIC = Buffer.from('RBK1');
const FORMAT = 1;

async function listTables(client) {
  const { rows } = await client.query(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`);
  return rows.map((r) => r.table_name).filter((t) => !SKIP.has(t));
}

// Parents before children, from the foreign keys that exist in the database being restored into.
async function loadOrder(client, tables) {
  const { rows } = await client.query(`select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent from pg_constraint c where c.contype = 'f' and c.connamespace = 'public'::regnamespace`);
  const strip = (n) => n.replace(/^public\./, '').replace(/"/g, '');
  const deps = new Map(tables.map((t) => [t, new Set()]));
  for (const r of rows) { const child = strip(r.child), parent = strip(r.parent); if (deps.has(child) && deps.has(parent) && child !== parent) deps.get(child).add(parent); }
  const order = [], done = new Set();
  while (order.length < tables.length) {
    const next = tables.filter((t) => !done.has(t) && [...deps.get(t)].every((p) => done.has(p)));
    if (!next.length) { order.push(...tables.filter((t) => !done.has(t))); break; } // a cycle: load the rest in name order
    for (const t of next) { order.push(t); done.add(t); }
  }
  return order;
}

async function exportData(client, { now = () => new Date() } = {}) {
  const tables = {}, counts = {};
  for (const t of await listTables(client)) {
    const { rows } = await client.query(`select to_jsonb(t) as r from public."${t}" t`);
    tables[t] = rows.map((x) => x.r); counts[t] = rows.length;
  }
  // Sign-in accounts: look at the columns first. A failing query would abort the surrounding backup transaction.
  let users = [];
  const { rows: cols } = await client.query(`select column_name from information_schema.columns where table_schema = 'auth' and table_name = 'users'`);
  const has = new Set(cols.map((c) => c.column_name));
  if (has.has('id')) users = (await client.query(`select id${has.has('email') ? ', email' : ''}${has.has('created_at') ? ', created_at' : ''} from auth.users order by id`)).rows;
  const migrations = (await client.query(`select to_regclass('supabase_migrations.schema_migrations') as t`)).rows[0].t
    ? (await client.query('select version from supabase_migrations.schema_migrations order by version')).rows.map((r) => r.version) : null;
  return { format: FORMAT, createdAt: now().toISOString(), counts, userCount: users.length, migrations, users, tables };
}

// ----- encryption: scrypt-derived key, AES-256-GCM over gzip. Layout: RBK1 | salt16 | iv12 | tag16 | ciphertext ------------------
function pack(data, passphrase) {
  const body = zlib.gzipSync(Buffer.from(JSON.stringify(data)));
  if (!passphrase) return Buffer.concat([Buffer.from('RBK0'), body]); // explicit opt-out only (scripts/backup.mjs --no-encrypt)
  if (String(passphrase).length < 16) throw new Error('The backup passphrase must be at least 16 characters');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(body), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), enc]);
}
function unpack(buf, passphrase) {
  const head = buf.subarray(0, 4).toString();
  let body;
  if (head === 'RBK0') body = buf.subarray(4);
  else if (head === 'RBK1') {
    if (!passphrase) throw new Error('This backup is encrypted: a passphrase is required');
    const salt = buf.subarray(4, 20), iv = buf.subarray(20, 32), tag = buf.subarray(32, 48);
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(passphrase, salt, 32), iv);
      d.setAuthTag(tag);
      body = Buffer.concat([d.update(buf.subarray(48)), d.final()]);
    } catch { throw new Error('Wrong passphrase, or the backup file is damaged or has been altered'); }
  } else throw new Error('Not a backup file');
  const data = JSON.parse(zlib.gunzipSync(body).toString());
  if (data.format !== FORMAT) throw new Error('Unsupported backup format');
  for (const [t, n] of Object.entries(data.counts)) if ((data.tables[t] || []).length !== n) throw new Error(`Backup is incomplete: table ${t}`);
  return data;
}

// ----- restore ---------------------------------------------------------------------------------------------------------------------------------
// Into a database that already has the migrations applied and is empty. Needs a role that may set session_replication_role (a superuser,
// i.e. a scratch database): triggers are switched off so the audit trail and role guards do not fire again on rows that already happened.
async function restoreData(client, data, { chunk = 500 } = {}) {
  await client.query('begin');
  try {
    await client.query(`set local session_replication_role = replica`);
    // Accounts the rows point to. In a scratch database auth.users is a stub; on Supabase the accounts already exist.
    for (const u of data.users) await client.query('insert into auth.users (id) values ($1) on conflict do nothing', [u.id]);
    const have = new Set(await listTables(client));
    for (const t of await loadOrder(client, Object.keys(data.tables))) {
      if (!have.has(t)) throw new Error(`The database has no table ${t}: apply the migrations first`);
      const rows = data.tables[t];
      const { rows: [{ n }] } = await client.query(`select count(*)::int as n from public."${t}"`);
      if (n) throw new Error(`Table ${t} is not empty: restore only into an empty database`);
      for (let i = 0; i < rows.length; i += chunk) await client.query(`insert into public."${t}" overriding system value select * from jsonb_populate_recordset(null::public."${t}", $1::jsonb)`, [JSON.stringify(rows.slice(i, i + chunk))]);
    }
    // Identity counters continue after the highest restored id.
    const { rows: ids } = await client.query(`select table_name, column_name from information_schema.columns where table_schema = 'public' and is_identity = 'YES'`);
    for (const { table_name: t, column_name: c } of ids) if (data.tables[t]) await client.query(`select setval(pg_get_serial_sequence('public."${t}"', '${c}'), greatest(coalesce((select max("${c}") from public."${t}"), 0), 1), (select count(*) > 0 from public."${t}"))`);
    await client.query('commit');
  } catch (e) { await client.query('rollback').catch(() => {}); throw e; }
}

// Row counts match the backup, the audit chain verifies, and every project belongs to an organisation. Returns { ok, problems }.
async function verifyRestore(client, data) {
  const problems = [];
  for (const [t, n] of Object.entries(data.counts)) {
    const { rows: [{ c }] } = await client.query(`select count(*)::int as c from public."${t}"`);
    if (c !== n) problems.push(`${t}: backup has ${n} rows, database has ${c}`);
  }
  if (data.tables.audit_log) {
    const { rows: [v] } = await client.query('select * from public.audit_verify()');
    if (v.first_bad_id !== null) problems.push(`audit chain broken at row ${v.first_bad_id}`);
  }
  if (data.tables.projects) {
    const { rows: [{ c }] } = await client.query('select count(*)::int as c from public.projects where organisation_id is null');
    if (c) problems.push(`${c} projects have no organisation`);
  }
  return { ok: problems.length === 0, problems };
}

module.exports = { exportData, pack, unpack, restoreData, verifyRestore, listTables, loadOrder, SKIP };
