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
 * Send one or more server events to the pixel dataset.
 *
 * events: [{ eventName, eventId, email, sourceUrl?, ip?, userAgent?, customData?, eventTime? }]
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
