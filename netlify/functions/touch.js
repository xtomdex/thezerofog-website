// POST /.netlify/functions/touch - the first-party attribution touch log.
//
// Body: { kind: 'pageview'|'email_field', url, ph?: {id, sid}, emailHash? }
//
// Every page of the site beacons here on load (shared.js), and the opt-in/schedule email
// fields beacon a browser-computed SHA-256 hash on blur. Together with wr_leads and
// wr_registrations this is what assembles a lead's full path - the cross-device seam is
// the salted IP hash: a phone that clicked the ad and a desktop that typed the address
// two minutes later usually sit on the same home Wi-Fi.
//
// Privacy posture, decided 2026-08-29:
// - The raw IP is hashed with TOUCH_SALT and never stored; rows expire after 30 days
//   (wr-retention). Unset TOUCH_SALT = no ip_hash at all, the row still lands.
// - The pre-submit email is hashed IN THE BROWSER; the raw address of someone who never
//   pressed the button never reaches us, and nothing here ever feeds an email list.
// - First-party, own server, hashed identifiers - not gated on the cookie banner; the
//   privacy page carries the disclosure.
//
// Best-effort by design: the visitor never waits on this and never sees it fail.

import { createHash } from 'node:crypto';
import { insert, json, preflight } from './lib/wr-db.js';

const PARAM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'from', 'qa'];

export default async function handler(req) {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: true }); // a broken beacon is not worth an error anywhere
  }

  const kind = body.kind === 'email_field' ? 'email_field' : 'pageview';

  let url = null;
  let path = null;
  const params = {};
  try {
    const u = new URL(String(body.url || ''));
    path = u.pathname;
    for (const key of PARAM_KEYS) {
      const v = u.searchParams.get(key);
      if (v) params[key] = v.slice(0, 300);
    }
    // The full URL is stored WITHOUT its query string - fbclid and utm live in params,
    // and anything else in a query string is somebody's tracking we don't want to hoard.
    url = `${u.origin}${u.pathname}`.slice(0, 500);
  } catch {
    /* no URL, row still worth keeping for the email_field kind */
  }

  // Referrers are stored WITHOUT their query string, and that is not cosmetic. On a same-origin
  // navigation the browser sends the full previous URL as Referer, and our own funnel pages carry
  // the join token in `?t=` - so `/confirmation/?t=<token>` -> `/workshop/room/?t=<token>` would
  // have written that token into this log. The token is the credential that opens somebody's room
  // and replay; it does not belong in an attribution row. Verified live before the fix: row 2 of
  // wr_touches stored `https://thezerofog.com/?qa=1&utm_source=qa-selftest` in full.
  const stripQuery = (u) => {
    try {
      const p = new URL(u);
      return `${p.origin}${p.pathname}`.slice(0, 300);
    } catch {
      return null; // not a URL we can parse - drop it rather than store something unknown
    }
  };

  const referrer = req.headers.get('referer');
  if (kind === 'pageview' && typeof body.ref === 'string' && body.ref) {
    const clean = stripQuery(body.ref);
    if (clean) params.ref = clean;
  } else if (referrer && kind === 'pageview') {
    const clean = stripQuery(referrer);
    if (clean) params.ref_header = clean;
  }

  const salt = process.env.TOUCH_SALT;
  const ip =
    req.headers.get('x-nf-client-connection-ip') ||
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  const ipHash = salt && ip ? createHash('sha256').update(salt + ip).digest('hex') : null;

  const emailHash =
    kind === 'email_field' && typeof body.emailHash === 'string' && /^[0-9a-f]{64}$/.test(body.emailHash)
      ? body.emailHash
      : null;
  if (kind === 'email_field' && !emailHash) return json({ ok: true });

  const row = {
    kind,
    url,
    path,
    params: Object.keys(params).length ? params : null,
    ip_hash: ipHash,
    ua: (req.headers.get('user-agent') || '').slice(0, 300) || null,
    ph_distinct_id:
      body.ph && typeof body.ph.id === 'string' ? body.ph.id.slice(0, 120) : null,
    ph_session_id:
      body.ph && typeof body.ph.sid === 'string' ? body.ph.sid.slice(0, 120) : null,
    email_hash: emailHash,
  };

  try {
    await insert('wr_touches', row, { returning: false });
  } catch (err) {
    console.error('touch: insert failed:', err.message);
  }
  return json({ ok: true });
}
