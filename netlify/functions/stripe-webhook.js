// Receives Stripe `checkout.session.completed` webhooks, verifies the Stripe
// signature (native crypto HMAC-SHA256 — no Stripe SDK / no npm dependencies),
// validates the payment (paid + expected amount + expected currency), and forwards
// a NORMALIZED payload to a Make webhook. Enrollment / LMS stay downstream in the
// Make scenario. The purchase-welcome email (E14) is the one email sent from here,
// via MailerLite directly — Make has been out of the email path since 2026-08-14.
//
// This endpoint is called server-to-server by Stripe (NOT from the browser), so it
// is NOT gated on a browser Origin. Response codes drive Stripe's retry behavior:
//   200 → handled, or intentionally ignored (don't retry)
//   400 → forged/invalid request (don't retry)
//   500 → transient failure (Stripe SHOULD retry)

import crypto from 'node:crypto';

// Stripe's standard replay tolerance: reject events whose timestamp is older
// (or further in the future) than 5 minutes.
const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Stamp `purchased_at` on this person's workshop registration, if they have one.
 *
 * Written with a bare fetch rather than through lib/wr-db.js so this handler keeps its property
 * of importing nothing but node:crypto — it is the one endpoint an attacker can reach without a
 * token, and its dependency surface is deliberately minimal.
 *
 * Swallows every error. A paid order must never fail because a follow-up flag did not save.
 */
async function markWorkshopBuyer(email) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key || !email) return;

  try {
    const endpoint = new URL(`${url}/rest/v1/wr_registrations`);
    endpoint.searchParams.set('email', `eq.${email.trim().toLowerCase()}`);

    const res = await fetch(endpoint, {
      method: 'PATCH',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ purchased_at: new Date().toISOString() }),
    });

    if (!res.ok) {
      console.error('markWorkshopBuyer: Supabase returned', res.status);
    }
  } catch (err) {
    console.error('markWorkshopBuyer failed:', err.message);
  }
}

/**
 * Send E14, the purchase-welcome email, by adding the buyer to the MailerLite group `wr-E14` —
 * the same join-fires-the-automation mechanism the whole workshop funnel uses (lib/wr-mailerlite.js).
 *
 * Written with bare fetch for the same reason as markWorkshopBuyer: this handler keeps its
 * import surface at node:crypto only. Two deliberate differences from the funnel transport:
 * no merge fields (E14's body needs none), and NO remove-before-add — adding an existing group
 * member fires no join, so a duplicate Stripe delivery cannot double-send the welcome.
 *
 * Best effort, never throws: a failed welcome email must not 500 a correctly processed payment
 * (Stripe would retry the whole event). A failure lands in the function log and support fixes it.
 */
async function sendPurchaseWelcome(email) {
  const key = process.env.MAILERLITE_API_KEY;
  if (!key || !email) {
    if (!key) console.error('E14 skipped: MAILERLITE_API_KEY is not set');
    return;
  }
  const base = process.env.MAILERLITE_API_BASE || 'https://connect.mailerlite.com/api';
  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  try {
    const gRes = await fetch(`${base}/groups?filter[name]=wr-E14`, { headers });
    if (!gRes.ok) {
      console.error('E14: group lookup returned', gRes.status);
      return;
    }
    const groups = (await gRes.json())?.data || [];
    const gid = groups.find((g) => g.name === 'wr-E14')?.id;
    if (!gid) {
      console.error('E14: no MailerLite group named wr-E14');
      return;
    }

    const up = await fetch(`${base}/subscribers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: email.trim().toLowerCase() }),
    });
    if (!up.ok) {
      console.error('E14: subscriber upsert returned', up.status);
      return;
    }
    const subscriberId = (await up.json())?.data?.id;
    if (!subscriberId) {
      console.error('E14: subscriber upsert returned no id');
      return;
    }

    const add = await fetch(`${base}/subscribers/${subscriberId}/groups/${gid}`, {
      method: 'POST',
      headers,
    });
    if (!add.ok) console.error('E14: group add returned', add.status);
  } catch (err) {
    console.error('sendPurchaseWelcome failed:', err.message);
  }
}

// Minimal headers kept for consistency with the other functions. Stripe does not
// send a CORS preflight, so no OPTIONS handling is required here.
const baseHeaders = {
  'Content-Type': 'application/json',
};

export default async function handler(req) {
  // Stripe only POSTs. Any other method is rejected.
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: baseHeaders,
    });
  }

  // Validate required server-side configuration.
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const makeWebhookUrl = process.env.MAKE_STRIPE_WEBHOOK_URL;
  const expectedAmount = process.env.EXPECTED_AMOUNT_TOTAL;
  const expectedCurrency = process.env.EXPECTED_CURRENCY;

  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET environment variable is not set');
    return serverConfigError();
  }
  if (!makeWebhookUrl) {
    console.error('MAKE_STRIPE_WEBHOOK_URL environment variable is not set');
    return serverConfigError();
  }
  if (!expectedAmount) {
    console.error('EXPECTED_AMOUNT_TOTAL environment variable is not set');
    return serverConfigError();
  }
  if (!expectedCurrency) {
    console.error('EXPECTED_CURRENCY environment variable is not set');
    return serverConfigError();
  }

  // Read the RAW body. Signature verification requires the EXACT bytes Stripe
  // signed — parsing + re-stringifying would change them and break the signature.
  const rawBody = await req.text();
  if (!rawBody) {
    console.error('Signature verification failed: empty request body');
    return invalidSignature();
  }

  // Verify the Stripe signature against the raw body before trusting anything.
  const sigHeader = req.headers.get('stripe-signature');
  const verification = verifyStripeSignature(rawBody, sigHeader, webhookSecret);
  if (!verification.valid) {
    console.error('Signature verification failed:', verification.reason);
    return invalidSignature();
  }

  // Only now is it safe to parse the verified raw body.
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    console.error('Signature valid but JSON parse failed:', err);
    return new Response(JSON.stringify({ error: 'Invalid payload' }), {
      status: 400,
      headers: baseHeaders,
    });
  }

  // We only act on completed checkouts. Any other event type is acknowledged
  // (200) so Stripe stops sending it, but we do nothing with it.
  if (event.type !== 'checkout.session.completed') {
    return received();
  }

  const session = event.data?.object || {};

  // Validate that this is a real, fully-paid order for OUR product. A
  // signature-valid event that fails these checks is acknowledged (200, no retry)
  // but NOT forwarded — we don't want to enroll, nor have Stripe retry.
  if (session.payment_status !== 'paid') {
    console.error('Payment validation failed: payment_status is', session.payment_status);
    return received();
  }
  if (String(session.amount_total) !== expectedAmount) {
    console.error(
      'Payment validation failed: amount_total',
      session.amount_total,
      'expected',
      expectedAmount
    );
    return received();
  }
  if (String(session.currency).toLowerCase() !== expectedCurrency.toLowerCase()) {
    console.error(
      'Payment validation failed: currency',
      session.currency,
      'expected',
      expectedCurrency
    );
    return received();
  }

  // Build the normalized payload — NOT the raw Stripe object.
  const email = session.customer_details?.email || null;
  if (!email) {
    // Should not happen for a paid session. Return 500 so Stripe retries in case
    // it was a transient/incomplete payload.
    console.error('Paid session missing customer email:', session.id);
    return new Response(JSON.stringify({ error: 'Missing customer email' }), {
      status: 500,
      headers: baseHeaders,
    });
  }

  const payload = {
    email,
    amount_total: session.amount_total,
    currency: session.currency,
    country: session.customer_details?.address?.country || null,
    session_id: session.id,
    source: 'stripe_checkout',
  };

  // Mark the buyer inside the workshop room, if this address ever registered for a session.
  //
  // This is the buyer guard the whole sales sequence hangs off: every follow-up email carries
  // "and not a buyer", and wr-notify.js reads exactly this column immediately before each send.
  // Stripe stays the single source of purchase truth - the room never decides who bought, it
  // only records what Stripe already established.
  //
  // Best effort, and deliberately so. A failure here must not make this handler return 500,
  // because that would have Stripe retry a payment that was processed correctly. The worst case
  // is one follow-up email reaching a customer, which the guard step in Make still catches.
  await markWorkshopBuyer(email);

  // Forward to Make. If Make is down or errors, return 500 so Stripe retries —
  // we don't want to silently lose a paid order.
  try {
    const upstream = await fetch(makeWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      console.error('Make webhook returned', upstream.status);
      return new Response(JSON.stringify({ error: 'Upstream error' }), {
        status: 500,
        headers: baseHeaders,
      });
    }
  } catch (err) {
    console.error('Failed to forward to Make:', err);
    return new Response(JSON.stringify({ error: 'Upstream error' }), {
      status: 500,
      headers: baseHeaders,
    });
  }

  // Best-effort app-user provisioning. Runs only after Make succeeded. Never affects the response:
  // the course (via Make) is already guaranteed; app access is a bonus that support can fix if it
  // fails. Awaited so it completes within the function lifetime, but fully wrapped.
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecret = process.env.SUPABASE_SECRET_KEY;
  if (supabaseUrl && supabaseSecret) {
    try {
      await provisionAppUser(email, session.id, supabaseUrl, supabaseSecret);
    } catch (err) {
      // Defensive: provisionAppUser shouldn't throw, but never let it break the 200 response.
      console.error('[provision] unexpected error (ignored):', err);
    }
  } else {
    console.warn('[provision] SUPABASE_URL or SUPABASE_SECRET_KEY not set — skipping app provisioning');
  }

  // The purchase-welcome email (E14). Runs only after Make succeeded, same contract as
  // provisioning above: awaited, best-effort, never affects the response.
  await sendPurchaseWelcome(email);

  return received();
}

// Best-effort: create (or find) the Supabase auth user for this buyer and mark their profile paid.
// MUST NOT throw — provisioning failure must not affect the Stripe response or course enrollment.
async function provisionAppUser(email, sessionId, supabaseUrl, secretKey) {
  const adminHeaders = {
    'Content-Type': 'application/json',
    'apikey': secretKey,
    'Authorization': `Bearer ${secretKey}`,   // new key format: must equal apikey value
    'User-Agent': 'zerofog-stripe-webhook',    // avoid 401 browser-origin rejection
  };

  let userId = null;

  // 1) Try to create the user (email_confirm:true so they can log in via OTP without confirmation).
  try {
    const createRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ email, email_confirm: true }),
    });
    if (createRes.ok) {
      const created = await createRes.json();
      userId = created?.id || created?.user?.id || null;
    } else {
      // Likely already exists (e.g. repeat purchase or Stripe retry). Fall through to lookup.
      console.warn('[provision] createUser non-OK:', createRes.status);
    }
  } catch (err) {
    console.error('[provision] createUser error:', err);
  }

  // 2) If we don't have an id yet, look the user up by email (admin list with filter).
  if (!userId) {
    try {
      const listRes = await fetch(
        `${supabaseUrl}/auth/v1/admin/users?` + new URLSearchParams({ email }),
        { method: 'GET', headers: adminHeaders }
      );
      if (listRes.ok) {
        const data = await listRes.json();
        const users = data?.users || data?.aud || [];
        const match = Array.isArray(users)
          ? users.find(u => (u.email || '').toLowerCase() === email.toLowerCase())
          : null;
        userId = match?.id || null;
      } else {
        console.warn('[provision] listUsers non-OK:', listRes.status);
      }
    } catch (err) {
      console.error('[provision] listUsers error:', err);
    }
  }

  if (!userId) {
    console.error('[provision] could not resolve user id for', email, '- profile not written');
    return;
  }

  // 3) Upsert the profile row marking the buyer paid (idempotent on user_id).
  try {
    const profRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?on_conflict=user_id`,
      {
        method: 'POST',
        headers: { ...adminHeaders, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          user_id: userId,
          email,
          is_paid: true,
          paid_at: new Date().toISOString(),
          payment_session_id: sessionId,
        }),
      }
    );
    if (!profRes.ok) {
      console.error('[provision] profile upsert non-OK:', profRes.status, await safeText(profRes));
    }
  } catch (err) {
    console.error('[provision] profile upsert error:', err);
  }
}

// small helper so logging a non-OK body can't throw
async function safeText(res){ try { return await res.text(); } catch { return ''; } }

// Verifies a Stripe-Signature header against the raw body using the signing secret.
// Header format: "t=TIMESTAMP,v1=SIGNATURE[,v1=SIGNATURE2...]". Returns
// { valid: boolean, reason?: string }. Accepts if ANY provided v1 matches.
function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) {
    return { valid: false, reason: 'missing stripe-signature header' };
  }

  let timestamp = null;
  const v1Signatures = [];
  for (const part of sigHeader.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't') {
      timestamp = value;
    } else if (key === 'v1') {
      v1Signatures.push(value);
    }
  }

  if (!timestamp || v1Signatures.length === 0) {
    return { valid: false, reason: 'malformed stripe-signature header' };
  }

  // Replay protection: reject timestamps outside the tolerance window.
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return { valid: false, reason: 'invalid signature timestamp' };
  }
  if (Math.abs(Date.now() / 1000 - timestampSeconds) > SIGNATURE_TOLERANCE_SECONDS) {
    return { valid: false, reason: 'timestamp outside tolerance' };
  }

  const signedPayload = `${timestamp}.${rawBody}`;
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');

  // Timing-safe comparison; guard length first so timingSafeEqual never throws.
  const matched = v1Signatures.some((sig) => {
    const sigBuf = Buffer.from(sig, 'utf8');
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  });

  if (!matched) {
    return { valid: false, reason: 'no matching v1 signature' };
  }

  return { valid: true };
}

function received() {
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: baseHeaders,
  });
}

function invalidSignature() {
  // 400 so Stripe does NOT retry — a forged/invalid request should be dropped.
  return new Response(JSON.stringify({ error: 'Invalid signature' }), {
    status: 400,
    headers: baseHeaders,
  });
}

function serverConfigError() {
  return new Response(JSON.stringify({ error: 'Server configuration error' }), {
    status: 500,
    headers: baseHeaders,
  });
}
