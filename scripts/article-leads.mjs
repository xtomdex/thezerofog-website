// Per SEO article: how many visits reached it, how many of those went on to the home page,
// and how many of those opted in - from our own touch log, attributed by referrer. Read-only.
//
//   node scripts/article-leads.mjs [--since YYYY-MM-DD] [--path /afternoon-crash/] [--emails]
//
// --since   window start (UTC midnight); default 30 days back, which is the touch log's own
//           retention window (wr-retention deletes older rows), so "everything" and "30 days"
//           are the same thing.
// --path    an article path to report on even if the log has never seen it; repeatable.
// --emails  print the opt-in addresses under the table. Without it only their dates appear.
//
// What each column means (fields are those touch.js writes, see netlify/functions/touch.js):
//   article_views  wr_touches rows with kind=pageview and path = the article
//   to_home        pageview rows on "/" whose params.ref (document.referrer, query stripped)
//                  is the article. params.ref_header is NOT used: it is the Referer header of
//                  the beacon POST itself, i.e. the page being viewed, never the previous page.
//   optins         wr_leads rows whose assembled path (same stitching as scripts/lead-path.mjs:
//                  email_hash -> ph_distinct_id -> ip_hash within +/-48h) contains either of the
//                  two kinds of row above. Counted once per lead. [ip] matches are probable,
//                  not proven - same caveat as lead-path.
//
// Reads are paged through PostgREST with Range headers and capped at MAX_TOUCHES; the cap is
// announced if hit. GET only. Never prints a key.

import fs from 'node:fs';
import { createHash } from 'node:crypto';

for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;
if (!BASE || !KEY) {
  console.error('SUPABASE_URL / SUPABASE_SECRET_KEY are not set (.env)');
  process.exit(2);
}

const MAX_TOUCHES = 20000;
const PAGE = 1000;
const IP_SEAM_MS = 48 * 3600 * 1000;
const OWN_HOST = /(^|\.)thezerofog\.com$/i;

// Paths that are the funnel or the legal set, never an article. Prefix match on the
// slash-terminated form, so /workshop/ covers /workshop/schedule/ and /workshop/room/.
const NOT_ARTICLES = [
  '/', '/hours/', '/workshop/', '/confirmation/', '/welcome/', '/sales/', '/app/', '/privacy/',
  '/terms/', '/refunds/', '/disclaimer/', '/contact/', '/replay/', '/r/', '/no-thanks/',
];
const ARTICLE_RE = /^\/[a-z]+(?:-[a-z]+)*\/$/;

// ----------------------------------------------------------------------------- args ----
const argv = process.argv.slice(2);
const args = { since: null, paths: [], emails: false };
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--since') args.since = argv[++i];
  else if (a === '--path') args.paths.push(argv[++i]);
  else if (a === '--emails') args.emails = true;
  else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
  else { console.error(`unknown argument: ${a}`); usage(); process.exit(2); }
}
function usage() {
  console.error('usage: node scripts/article-leads.mjs [--since YYYY-MM-DD] [--path /afternoon-crash/] [--emails]');
}
if (args.since && !/^\d{4}-\d{2}-\d{2}$/.test(args.since)) {
  console.error('--since must be YYYY-MM-DD'); process.exit(2);
}
const sinceIso = args.since
  ? `${args.since}T00:00:00Z`
  : new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
const sinceLabel = sinceIso.slice(0, 10);

// ------------------------------------------------------------------------- helpers ----
function norm(path) {
  // "/afternoon-crash" and "/afternoon-crash/" are the same page; compare the slashed form.
  if (typeof path !== 'string' || !path.startsWith('/')) return null;
  return path.endsWith('/') ? path : `${path}/`;
}

function refPath(ref) {
  // params.ref is `${origin}${pathname}` (touch.js strips the query). Own-domain refs only:
  // an article path is only meaningful on our own host.
  if (typeof ref !== 'string') return null;
  try {
    const u = new URL(ref);
    if (!OWN_HOST.test(u.hostname)) return null;
    return norm(u.pathname);
  } catch {
    return null;
  }
}

function isArticlePath(p) {
  if (!p || !ARTICLE_RE.test(p)) return false;
  return !NOT_ARTICLES.some((x) => (x === '/' ? p === '/' : p.startsWith(x)));
}

function emailHashOf(email) {
  return createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
}

/** GET one table through PostgREST, paging with Range headers. Never more than `cap` rows. */
async function pageAll(table, query, cap) {
  const rows = [];
  let total = null;
  let from = 0;
  for (;;) {
    const want = Math.min(PAGE, cap - rows.length);
    if (want <= 0) break;
    const to = from + want - 1;
    const res = await fetch(`${BASE}/rest/v1/${table}?${query}`, {
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        'Range-Unit': 'items',
        Range: `${from}-${to}`,
        Prefer: 'count=exact',
      },
    });
    if (res.status === 416) break; // asked past the end
    if (!res.ok) throw new Error(`${table}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const cr = res.headers.get('content-range') || '';
    const m = cr.match(/\/(\d+|\*)$/);
    if (m && m[1] !== '*') total = Number(m[1]);
    const chunk = await res.json();
    rows.push(...chunk);
    if (chunk.length < want) break;
    if (total !== null && rows.length >= total) break;
    from += chunk.length;
  }
  return { rows, total: total ?? rows.length };
}

// --------------------------------------------------------------------------- fetch ----
const touchQ = `select=id,created_at,kind,path,params,ip_hash,ph_distinct_id,email_hash` +
  `&created_at=gte.${encodeURIComponent(sinceIso)}&order=created_at.asc,id.asc`;
const touches = await pageAll('wr_touches', touchQ, MAX_TOUCHES);
const capHit = touches.total > touches.rows.length;

const leadQ = `select=id,email,created_at,data&created_at=gte.${encodeURIComponent(sinceIso)}` +
  `&order=created_at.asc`;
const leads = await pageAll('wr_leads', leadQ, MAX_TOUCHES);

const regQ = `select=email,created_at,data&created_at=gte.${encodeURIComponent(sinceIso)}` +
  `&order=created_at.asc`;
const regs = await pageAll('wr_registrations', regQ, MAX_TOUCHES);

// -------------------------------------------------------------------------- indexes ----
const byEmailHash = new Map();
const byPh = new Map();
const byIp = new Map();
const push = (map, key, t) => { if (key) (map.get(key) || map.set(key, []).get(key)).push(t); };
for (const t of touches.rows) {
  t.npath = norm(t.path);
  t.nref = t.kind === 'pageview' ? refPath(t.params?.ref) : null;
  t.qa = Boolean(t.params?.qa);
  push(byEmailHash, t.email_hash, t);
  push(byPh, t.ph_distinct_id, t);
  push(byIp, t.ip_hash, t);
}

const regByEmail = new Map();
for (const r of regs.rows) {
  const k = String(r.email || '').trim().toLowerCase();
  if (k && !regByEmail.has(k)) regByEmail.set(k, r);
}

// ------------------------------------------------------------------- article paths ----
// Three sources, unioned: the articles on disk (src/articles/*.md permalinks - so a live but
// never-visited article still gets its honest zero line), any article-shaped path the log has
// seen (as a pageview, or as the referrer of a "/" pageview), and --path.
const onDisk = new Set();
try {
  const dir = new URL('../src/articles/', import.meta.url);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const m = fs.readFileSync(new URL(f, dir), 'utf8').match(/^permalink:\s*(\S+)/m);
    if (m && norm(m[1])) onDisk.add(norm(m[1]));
  }
} catch { /* no src/articles yet - the log and --path still work */ }

const articleSet = new Set(onDisk);
for (const t of touches.rows) {
  if (t.kind !== 'pageview') continue;
  if (isArticlePath(t.npath)) articleSet.add(t.npath);
  if (t.npath === '/' && isArticlePath(t.nref)) articleSet.add(t.nref);
}
for (const p of args.paths) {
  const n = norm(p);
  if (!n) { console.error(`--path must start with "/": ${p}`); process.exit(2); }
  articleSet.add(n);
}
const articles = [...articleSet].sort();

// ---------------------------------------------------------- lead path assembly ----
// Mirrors scripts/lead-path.mjs, in memory over the window's touches instead of per-lead
// queries: (1) email_hash, (2) ph ids from wr_leads / wr_registrations data.posthog and from
// the touches found so far, (3) one expansion through ip_hash within +/-48h of an owned touch.
function assemblePath(lead) {
  const email = String(lead.email || '').trim().toLowerCase();
  const own = new Map();
  for (const t of byEmailHash.get(emailHashOf(email)) || []) own.set(t.id, t);

  const phIds = new Set();
  const reg = regByEmail.get(email);
  for (const src of [lead.data?.posthog, reg?.data?.posthog]) {
    if (src?.distinct_id) phIds.add(src.distinct_id);
  }
  for (const t of own.values()) if (t.ph_distinct_id) phIds.add(t.ph_distinct_id);
  for (const id of phIds) for (const t of byPh.get(id) || []) own.set(t.id, t);

  const ownList = [...own.values()];
  const ownTimes = ownList.map((t) => new Date(t.created_at).getTime());
  const probable = new Map();
  for (const ip of new Set(ownList.map((t) => t.ip_hash).filter(Boolean))) {
    for (const t of byIp.get(ip) || []) {
      if (own.has(t.id) || probable.has(t.id)) continue;
      const at = new Date(t.created_at).getTime();
      if (ownTimes.some((o) => Math.abs(o - at) < IP_SEAM_MS)) probable.set(t.id, t);
    }
  }
  return [...ownList, ...probable.values()];
}

const leadPaths = leads.rows.map((lead) => ({ lead, path: assemblePath(lead) }));

// --------------------------------------------------------------------------- count ----
const report = {};
for (const a of articles) {
  const views = touches.rows.filter((t) => t.kind === 'pageview' && t.npath === a);
  const toHome = touches.rows.filter((t) => t.kind === 'pageview' && t.npath === '/' && t.nref === a);
  const ips = (list) => new Set(list.map((t) => t.ip_hash).filter(Boolean)).size;
  const optins = leadPaths.filter(({ path }) =>
    path.some((t) => t.kind === 'pageview' && (t.npath === a || (t.npath === '/' && t.nref === a))),
  );
  report[a] = {
    on_disk: onDisk.has(a),
    views: views.length,
    views_ip: ips(views),
    views_qa: views.filter((t) => t.qa).length,
    to_home: toHome.length,
    to_home_ip: ips(toHome),
    optins: optins.length,
    optin_dates: optins.map(({ lead }) => lead.created_at.slice(0, 10)),
    optin_emails: optins.map(({ lead }) => lead.email),
  };
}

// --------------------------------------------------------------------------- print ----
const untilIso = new Date().toISOString();
const NONE_VIEWS = '0 (page not live yet or no touches in window)';
const NONE = '0 (none in window)';
const cell = (n, ip) => (n === 0 ? NONE : `${n} (${ip} ip)`);

console.log(`\nArticle leads - since ${sinceLabel} (UTC) until ${untilIso.slice(0, 16).replace('T', ' ')} UTC`);
console.log(`touches scanned: ${touches.rows.length} of ${touches.total} in window` +
  (capHit ? `  <- CAP OF ${MAX_TOUCHES} HIT, oldest ${touches.rows.length} only; narrow --since` : '') +
  `; leads in window: ${leads.rows.length}; registrations in window: ${regs.rows.length}`);
if (touches.rows.length) {
  console.log(`touch range actually scanned: ${touches.rows[0].created_at} .. ${touches.rows.at(-1).created_at}`);
}
console.log('');

if (!articles.length) {
  console.log('no article paths found in the window and none given with --path');
} else {
  const rows = articles.map((a) => {
    const r = report[a];
    return [
      r.on_disk ? a : `${a} (not in src/articles)`,
      r.views === 0 ? NONE_VIEWS : `${r.views} (${r.views_ip} ip${r.views_qa ? `, ${r.views_qa} qa` : ''})`,
      cell(r.to_home, r.to_home_ip),
      r.optins === 0 ? NONE : String(r.optins),
      r.optin_dates.length ? r.optin_dates.join(' ') : '-',
    ];
  });
  const head = ['article', 'article_views', 'to_home', 'optins', 'optin_dates'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  console.log(line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));

  if (args.emails) {
    console.log('');
    for (const a of articles) {
      const r = report[a];
      if (!r.optins) continue;
      console.log(`${a} opt-ins:`);
      r.optin_dates.forEach((d, i) => console.log(`  ${d}  ${r.optin_emails[i]}`));
    }
  }
}

console.log('');
const machine = {
  since: sinceLabel,
  until: untilIso,
  touches_scanned: touches.rows.length,
  touches_in_window: touches.total,
  cap_hit: capHit,
  leads_in_window: leads.rows.length,
  articles: Object.fromEntries(articles.map((a) => {
    const { optin_emails, ...rest } = report[a];
    return [a, rest];
  })),
};
console.log(`ARTICLES ${JSON.stringify(machine)}`);
