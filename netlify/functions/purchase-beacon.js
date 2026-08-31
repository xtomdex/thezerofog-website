// POST /.netlify/functions/purchase-beacon
//
// Body: { session_id }
//
// The first-party twin of the browser's Purchase pixel, and the only place a completed sale is
// observable WITH the buyer's live network identity.
//
// Why it exists. Meta scored our Purchase 3.2 out of 10 on match quality on 2026-08-31 - the
// worst event on the pixel, on the one that decides whether an ad gets credit for a sale. The
// cause is structural: `checkout.session.completed` arrives at stripe-webhook.js from Stripe's
// servers, so that request has no browser on it - no IP, no user agent, no cookies. The browser
// pixel on /welcome/ does have all of them, and in this audience it is blocked more often than
// it runs (the CEO's own Chrome never executes fbevents.js). This call goes to our own domain,
// which blockers do not touch, and carries what the webhook cannot see.
//
// Deduplication: event_id is the Stripe checkout session id - the same id the browser pixel and
// the webhook both use, so Meta collapses all three into one sale inside its 48-hour window.
// Meta keeps the FIRST copy of a duplicate, and this one usually wins the race, which is why it
// carries value and currency rather than leaving them to the webhook.
//
// Nothing is stored. The IP and the user agent exist for the length of this request and are
// forwarded to Meta as match keys, never written to a table - that is the whole point of doing
// it here instead of parking them at opt-in and reading them back a day later.
//
// Never trusts the client. The body carries a session id and nothing else; the amount, the
// currency and the buyer's address are read back from Stripe. A forged or unpaid id sends
// nothing.

import { json, preflight } from './lib/wr-db.js';
import { sendMetaEvents, clientInfo, fbCookies, trackingAllowed, SITE_URL } from './lib/meta-capi.js';

/**
 * Read the session back from Stripe and answer one question: is this a real, paid, live session,
 * and whose is it? Restricted keys are per-resource, so a key without read on Checkout Sessions
 * simply returns null here and the beacon goes quiet rather than guessing.
 */
async function verifiedSession(sessionId) {
  // STRIPE_READ_KEY first: a restricted key with READ on Checkout Sessions and nothing else.
  // STRIPE_SECRET_KEY is the site's checkout key and may well have no read permission at all -
  // restricted keys are per-resource - so it is only the fallback, and a 401/403 from it is a
  // configuration answer, not an outage.
  const key = process.env.STRIPE_READ_KEY || process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error('purchase-beacon: no Stripe key set - Purchase NOT sent for', sessionId);
    return null;
  }

  try {
    const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    });
    if (!res.ok) {
      // 401/403 means the key cannot read sessions and every sale is going out short-matched;
      // 404 is just a bad id. Both are loud on purpose - the failure mode of this whole file is
      // silence, and silence looks exactly like "no sales happened".
      console.error(
        `purchase-beacon: Stripe ${res.status} for ${sessionId}` +
          (res.status === 401 || res.status === 403
            ? ' - THE KEY CANNOT READ CHECKOUT SESSIONS, Purchase went without live match keys'
            : '')
      );
      return null;
    }
    const s = await res.json();
    if (s.payment_status !== 'paid') {
      console.warn('purchase-beacon: session not paid:', sessionId, s.payment_status);
      return null;
    }
    // A comped seat must never teach the optimizer what a buyer looks like - same rule as the
    // webhook, which excludes it there too.
    if (s.metadata?.zf_comp === 'granted') return null;
    const email = s.customer_details?.email || s.customer_email || null;
    if (!email) {
      console.error('purchase-beacon: paid session with no email:', sessionId);
      return null;
    }
    return {
      email,
      value: Number(s.amount_total || 0) / 100,
      currency: String(s.currency || 'usd').toUpperCase(),
    };
  } catch (err) {
    console.error('purchase-beacon: Stripe lookup failed:', err.message);
    return null;
  }
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // Same consent split as every other tracker on the site.
  if (!trackingAllowed(req)) return json({ ok: true }, 200);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: true }, 200);
  }

  const sessionId = typeof body?.session_id === 'string' ? body.session_id.trim() : '';
  // Shape check before spending a Stripe call on it.
  if (!/^cs_(live|test)_[A-Za-z0-9]{10,200}$/.test(sessionId)) return json({ ok: true }, 200);

  const sale = await verifiedSession(sessionId);
  if (!sale) return json({ ok: true }, 200);

  try {
    const { ip, userAgent } = clientInfo(req);
    const { fbp, fbc } = fbCookies(req);
    await sendMetaEvents([
      {
        eventName: 'Purchase',
        eventId: sessionId,
        email: sale.email,
        sourceUrl: `${SITE_URL}/welcome/`,
        ip,
        userAgent,
        fbp,
        fbc,
        externalId: sale.email,
        customData: { value: sale.value, currency: sale.currency },
      },
    ]);
  } catch (err) {
    console.error('purchase-beacon: meta event failed:', err.message);
  }

  return json({ ok: true }, 200);
}
