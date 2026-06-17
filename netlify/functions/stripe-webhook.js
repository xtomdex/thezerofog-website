// Receives Stripe `checkout.session.completed` webhooks, verifies the Stripe
// signature (native crypto HMAC-SHA256 — no Stripe SDK / no npm dependencies),
// validates the payment (paid + expected amount + expected currency), and forwards
// a NORMALIZED payload to a Make webhook. This is a thin secure gateway only —
// enrollment / LMS / MailerLite happen downstream in the Make scenario, not here.
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

  return received();
}

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
