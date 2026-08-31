// Meta Conversions API - server-side events.
//
// Why this exists: the browser pixel is consent-gated and widely blocked (the CEO's own Chrome
// never executes fbevents.js), so the deepest funnel facts - who joined the room, who sat to the
// reveal, who bought - either never reach Meta or reach it only from unblocked browsers. These
// events are server truth: wr-heartbeat's clamped attendance and Stripe's webhook. Meta needs
// ~50 events/week on an optimization goal before an ad set leaves learning, and lookalike seeds
// start at ~100 people - the accumulation has to start long before it is needed.
//
// Deduplication: every event carries an event_id that is stable for its (registration, stage)
// pair, so retries and reloads collapse inside Meta's 48-hour dedup window. The Purchase twin
// uses the Stripe checkout session id - the SAME id the browser pixel sends from /welcome/
// (cookie-consent-5.js) - so when both sides fire, Meta counts one sale, not two.
//
// Best-effort by design: unset env means silent no-op, an API error is logged and swallowed.
// Nothing in the funnel may fail because Meta was unreachable. Calls must be AWAITED by the
// caller - a serverless function that has returned can be frozen mid-request.

import { createHash } from 'node:crypto';

const API_VERSION = 'v21.0';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Normalize + hash an email the way Meta's matching expects. */
function hashEmail(email) {
  if (typeof email !== 'string' || !email.trim()) return null;
  return sha256(email.trim().toLowerCase());
}

/** Best-effort client network facts from the incoming request (the room and the schedule step
 * POST straight from the visitor's browser, so these are the real visitor's, not a proxy's). */
export function clientInfo(req) {
  const ip =
    req.headers.get('x-nf-client-connection-ip') ||
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    null;
  const userAgent = req.headers.get('user-agent') || null;
  return { ip, userAgent };
}

/**
 * The two Meta browser cookies, read from the request that carries them.
 *
 * `_fbp` is the browser id the pixel sets; `_fbc` is the click id Meta writes after a visitor
 * arrives with `?fbclid=`. They are the strongest match keys we can hold, because they identify
 * the CLICK, not just the person - without them Meta can tell that someone bought, but not that
 * the buyer is the one it charged us for. Both are plain first-party cookies on our own domain,
 * so they arrive on every POST our own pages make.
 *
 * Sent to Meta raw and NEVER hashed: they are already opaque ids, and hashing them destroys the
 * match. That is the opposite of the rule for email, name and address.
 */
export function fbCookies(req) {
  const jar = req.headers.get('cookie') || '';
  const pick = (name) => {
    const hit = jar.split(';').find((part) => part.trim().startsWith(`${name}=`));
    if (!hit) return null;
    const value = hit.trim().slice(name.length + 1).trim();
    return value ? value.slice(0, 400) : null;
  };
  return { fbp: pick('_fbp'), fbc: pick('_fbc') };
}

/**
 * The same consent split the browser runs, decided server-side.
 *
 * cookie-consent-5.js splits by jurisdiction: EU-27 + EEA + UK + CH (and any country it cannot
 * resolve) are opt-in - nothing loads until "Accept All"; everywhere else is opt-out. The
 * `zf_cookies_consent` cookie is domain-wide, so a decision the visitor already made arrives
 * here on its own.
 *
 * This exists because `fbcFromUrl` can rebuild the click id from `?fbclid=` even when the pixel
 * never ran - which is the whole point of it, and also exactly the case the banner is supposed
 * to gate. Reading Meta's own `_fbp`/`_fbc` cookies needs no gate (they only exist if the pixel
 * was allowed to set them), but they go through the same door here so there is one rule, not two.
 *
 * Country comes from `x-nf-geo`, which Netlify sets at the edge and strips from client input;
 * `x-country` is the fallback. Unknown country falls back to the strict side, same as the client.
 */
const OPT_IN_COUNTRIES = new Set([
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU',
  'MT','NL','PL','PT','RO','SK','SI','ES','SE','IS','LI','NO','GB','CH',
]);

export function trackingAllowed(req) {
  const jar = req.headers.get('cookie') || '';
  const choice = jar.match(/(?:^|;\s*)zf_cookies_consent=(all|essential)(?:;|$)/);
  if (choice) return choice[1] === 'all';

  // No choice on record: the regime decides, exactly as it does in the browser.
  let country = '';
  const nfGeo = req.headers.get('x-nf-geo');
  if (nfGeo) {
    try {
      country = JSON.parse(Buffer.from(nfGeo, 'base64').toString('utf8'))?.country?.code || '';
    } catch {
      country = '';
    }
  }
  if (!country) country = (req.headers.get('x-country') || '').toUpperCase();
  if (!country) return false;
  return !OPT_IN_COUNTRIES.has(country.toUpperCase());
}

/**
 * Build an `_fbc` value out of a landing URL that carries `?fbclid=`.
 *
 * Meta's own format is `fb.<subdomain-index>.<creation-time-ms>.<fbclid>`, and `fb.1.<ts>.<id>`
 * is what the pixel itself writes on a root domain. We need this because the cookie only exists
 * if the pixel ran, and in this audience the pixel is blocked more often than not - but the
 * `fbclid` is still sitting in the URL the browser sent us. Same click, one hop earlier.
 */
export function fbcFromUrl(url, whenMs) {
  if (typeof url !== 'string' || !url) return null;
  let fbclid = null;
  try {
    fbclid = new URL(url).searchParams.get('fbclid');
  } catch {
    return null;
  }
  if (!fbclid) return null;
  return `fb.1.${Math.floor(whenMs || Date.now())}.${fbclid.slice(0, 400)}`;
}

/**
 * Send one or more server events to the pixel dataset.
 *
 * events: [{ eventName, eventId, email, sourceUrl?, ip?, userAgent?, fbp?, fbc?, externalId?,
 *            customData?, eventTime? }]
 */
export async function sendMetaEvents(events) {
  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_TOKEN;
  if (!pixelId || !token || !Array.isArray(events) || events.length === 0) return;

  const data = [];
  for (const e of events) {
    const em = hashEmail(e.email);
    // Email is our only reliable match key; an event Meta cannot match to a person buys nothing.
    if (!em) continue;

    const userData = { em: [em] };
    if (e.ip) userData.client_ip_address = e.ip;
    if (e.userAgent) userData.client_user_agent = e.userAgent;
    // Raw, not hashed - see fbCookies above.
    if (e.fbp) userData.fbp = e.fbp;
    if (e.fbc) userData.fbc = e.fbc;
    // A stable id for the same human across events. Hashed like the other identifiers.
    if (e.externalId) userData.external_id = [sha256(String(e.externalId).trim().toLowerCase())];

    const row = {
      event_name: e.eventName,
      event_time: Math.floor((e.eventTime || Date.now()) / 1000),
      event_id: e.eventId,
      action_source: 'website',
      user_data: userData,
    };
    if (e.sourceUrl) row.event_source_url = e.sourceUrl;
    if (e.customData) row.custom_data = e.customData;
    data.push(row);
  }
  if (!data.length) return;

  const body = { data };
  // Visible in Events Manager -> Test events while set; remove the env var to go quiet.
  if (process.env.META_CAPI_TEST_CODE) body.test_event_code = process.env.META_CAPI_TEST_CODE;

  try {
    const res = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${pixelId}/events?access_token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`meta-capi: ${res.status} for ${data.map((d) => d.event_name).join(',')}: ${detail.slice(0, 300)}`);
    }
  } catch (err) {
    console.error('meta-capi: send failed:', err.message);
  }
}

export const SITE_URL = process.env.PUBLIC_SITE_URL || 'https://thezerofog.com';
