// Assemble one lead's full attribution path from the touch log + funnel tables.
//
//   node scripts/lead-path.mjs someone@example.com
//
// Stitching order (strongest seam first):
//   1. email_hash   - the same address typed anywhere (pre-submit capture included)
//   2. ph ids       - the same browser (wr_leads/wr_registrations data.posthog + touches)
//   3. ip_hash      - the same network within +/-48h of any touch already attributed
//      (the cross-device seam: phone ad click -> desktop opt-in on home Wi-Fi).
// IP matches are marked [ip] in the output - they are probable, not proven. Read-only.

import fs from 'node:fs';
import { createHash } from 'node:crypto';

for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;
const email = (process.argv[2] || '').trim().toLowerCase();
if (!email) { console.error('usage: node scripts/lead-path.mjs <email>'); process.exit(2); }

async function q(table, query) {
  const res = await fetch(`${BASE}/rest/v1/${table}?${query}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
  return res.json();
}

const emailHash = createHash('sha256').update(email).digest('hex');

const [lead] = await q('wr_leads', `select=*&email=eq.${encodeURIComponent(email)}`);
const [reg] = await q('wr_registrations', `select=*,wr_sessions(starts_at),wr_attendance(*)&email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=1`);

// Seams we know belong to this person.
const phIds = new Set();
for (const src of [lead?.data?.posthog, reg?.data?.posthog]) {
  if (src?.distinct_id) phIds.add(src.distinct_id);
}

const own = [];
own.push(...(await q('wr_touches', `select=*&email_hash=eq.${emailHash}`)));
for (const id of phIds) {
  own.push(...(await q('wr_touches', `select=*&ph_distinct_id=eq.${encodeURIComponent(id)}`)));
}
for (const t of own) if (t.ph_distinct_id) phIds.add(t.ph_distinct_id);

// Expand once through the IP seam: touches on the same network within 48h of an owned touch.
const ipHashes = [...new Set(own.map((t) => t.ip_hash).filter(Boolean))];
const probable = [];
for (const ip of ipHashes) {
  const near = await q('wr_touches', `select=*&ip_hash=eq.${ip}`);
  for (const t of near) {
    if (own.some((o) => o.id === t.id)) continue;
    const close = own.some((o) => Math.abs(new Date(o.created_at) - new Date(t.created_at)) < 48 * 3600 * 1000);
    if (close) probable.push(t);
  }
}

const seen = new Set();
const rows = [];
for (const t of [...own.map((t) => ({ ...t, seam: '' })), ...probable.map((t) => ({ ...t, seam: '[ip]' }))]) {
  if (seen.has(t.id)) continue;
  seen.add(t.id);
  const p = t.params || {};
  const src = p.utm_source ? `${p.utm_source}/${p.utm_campaign || ''}${p.utm_content ? ':' + p.utm_content : ''}` : p.fbclid ? 'fbclid' : p.ref ? `ref:${p.ref.slice(0, 40)}` : 'direct';
  rows.push({ at: t.created_at, what: `${t.kind} ${t.path || ''} ${src} ${t.seam}`.trim() });
}
if (lead) rows.push({ at: lead.created_at, what: `OPTIN (wr_leads) ${lead.data?.utm ? JSON.stringify(lead.data.utm) : ''}` });
if (reg) {
  rows.push({ at: reg.created_at, what: `REGISTERED slot ${Array.isArray(reg.wr_sessions) ? reg.wr_sessions[0]?.starts_at : reg.wr_sessions?.starts_at}` });
  const att = Array.isArray(reg.wr_attendance) ? reg.wr_attendance[0] : reg.wr_attendance;
  if (att?.first_seen_at) rows.push({ at: att.first_seen_at, what: `JOINED room (watched ${att.total_watched_sec}s, segments ${JSON.stringify(att.segments)})` });
  if (reg.purchased_at) rows.push({ at: reg.purchased_at, what: 'PURCHASED' });
}

rows.sort((a, b) => new Date(a.at) - new Date(b.at));
console.log(`\nPath for ${email} (${rows.length} steps; [ip] = probable cross-device match):\n`);
for (const r of rows) console.log(`  ${r.at}  ${r.what}`);
if (!rows.length) console.log('  nothing found');
