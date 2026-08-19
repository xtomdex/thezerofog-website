// Creates a Stripe Checkout Session (one-time payment) via the Stripe REST API
// using native fetch — no Stripe SDK / no npm dependencies. Returns the hosted
// checkout URL for the client to redirect to. Checkout collects email only
// (Stripe does this automatically); no name/address is collected.
//
// NOTE: Webhook handling / LMS enrollment is a SEPARATE later task — not here.

const ALLOWED_ORIGIN = 'https://thezerofog.com';

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const STRIPE_CHECKOUT_ENDPOINT = 'https://api.stripe.com/v1/checkout/sessions';

// EU consumer-rights waiver (Art. 16(m), Directive 2011/83/EU): the buyer must
// actively consent to immediate delivery of digital content, waiving the 14-day
// withdrawal right. Requires the Terms of Service URL to be set in the Stripe
// Dashboard (Settings -> Business -> Public details); until it is set, Stripe
// rejects sessions with consent_collection, so we retry without it (see below).
// [attorney] exact waiver wording is on the review checklist.
const TOS_CONSENT_MESSAGE =
  'I request immediate access to the digital content and acknowledge that I ' +
  'thereby lose my EU 14-day right of withdrawal. This does not affect the ' +
  '30-day guarantee described in the [Refund Policy](https://thezerofog.com/refunds/).';

function buildSessionParams(priceId, baseUrl, withTosConsent, compCoupon) {
  // Stripe expects bracket notation for nested and array params. URLSearchParams
  // encodes the literal {CHECKOUT_SESSION_ID} template braces as %7B...%7D,
  // which Stripe accepts and replaces server-side.
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('line_items[0][price]', priceId);
  params.set('line_items[0][quantity]', '1');
  params.set('success_url', `${baseUrl}/welcome/?session_id={CHECKOUT_SESSION_ID}`);
  params.set('cancel_url', `${baseUrl}/sales/`);
  // Extensible metadata — a later task can add lead_id/source without restructuring.
  params.set('metadata[source]', 'sales_page');
  // Expire abandoned checkouts after 2 hours (Stripe allows 30min-24h, default 24h).
  // The `checkout.session.expired` webhook is what triggers the E18 abandoned-checkout
  // email — with the default expiry it would arrive a full day late.
  params.set('expires_at', String(Math.floor(Date.now() / 1000) + 2 * 60 * 60));
  // Adaptive Pricing presents the price in the buyer's local currency, and the
  // completed session then reports THAT currency and amount. stripe-webhook.js
  // compares both against EXPECTED_AMOUNT_TOTAL / EXPECTED_CURRENCY and returns
  // 200 (no retry) on a mismatch — so a non-USD buyer would pay and never be
  // enrolled, silently. Off here rather than in the Dashboard: this cannot be
  // undone by a stray click, and it shows up in a diff.
  params.set('adaptive_pricing[enabled]', 'false');
  if (withTosConsent) {
    params.set('consent_collection[terms_of_service]', 'required');
    params.set('custom_text[terms_of_service_acceptance][message]', TOS_CONSENT_MESSAGE);
  }
  // A comped seat - see the GET branch in the handler. The coupon takes the price to zero,
  // and the metadata marker is what stripe-webhook.js checks before it lets a zero-amount
  // session through its amount guard. The marker is written HERE, server-side, on a session
  // Stripe then signs, so it cannot be forged by whoever opens the link.
  if (compCoupon) {
    params.set('discounts[0][coupon]', compCoupon);
    params.set('metadata[zf_comp]', 'granted');
    params.set('metadata[source]', 'comp_link');
  }
  return params;
}

export default async function handler(req) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // Validate required server-side configuration.
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const priceId = process.env.STRIPE_PRICE_ID;
  const siteUrl = process.env.PUBLIC_SITE_URL;

  if (!secretKey) {
    console.error('STRIPE_SECRET_KEY environment variable is not set');
    return serverConfigError();
  }
  if (!priceId) {
    console.error('STRIPE_PRICE_ID environment variable is not set');
    return serverConfigError();
  }
  if (!siteUrl) {
    console.error('PUBLIC_SITE_URL environment variable is not set');
    return serverConfigError();
  }

  // Normalize base URL (strip any trailing slash) so we build clean paths.
  const baseUrl = siteUrl.replace(/\/$/, '');

  // ---------------------------------------------------------------- comp link
  // One clickable link that opens a checkout already discounted to zero, for a person we
  // are giving the course to rather than selling it: a tester walking the funnel, or a
  // guest seat. It is a GET so it can be pasted into a message, and it redirects straight
  // into Stripe's own checkout - so the tester sees the real page, presses the real button
  // and travels the real webhook, with no card and no money.
  //
  // Gated on COMP_ACCESS_KEY, compared in full. Nothing about the normal POST path changes,
  // and no promotion-code field ever appears for a real buyer.
  if (req.method === 'GET') {
    const key = new URL(req.url).searchParams.get('key') || '';
    const expected = process.env.COMP_ACCESS_KEY || '';
    const coupon = process.env.COMP_COUPON_ID || '';
    if (!expected || !coupon || key !== expected) {
      // Deliberately the same answer as a wrong method: a probe learns nothing about
      // whether comp links exist at all.
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const made = await createSession(secretKey, priceId, baseUrl, coupon);
    if (!made.url) {
      // Whoever holds the key is us, and a silent 500 on an admin link is a dead end -
      // Stripe's own sentence is what tells you which dashboard switch is off.
      return new Response(JSON.stringify({ error: 'Comp link failed', stripe: made.error }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    // NOT a 303. Netlify appends the incoming query string to a redirect Location, which put
    // COMP_ACCESS_KEY inside the checkout.stripe.com URL - our admin key in a third party's
    // logs and in the tester's history. A one-line page hands the browser the URL Stripe gave
    // us and nothing else, and the visible link is there for anyone with scripts off.
    const safe = made.url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>Opening checkout</title>` +
      `<body style="font:16px/1.5 system-ui;padding:40px;text-align:center">` +
      `<p>Opening checkout...</p><p><a href="${safe}">Continue to checkout</a></p>` +
      `<script>location.replace(${JSON.stringify(made.url)})</script>`,
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' } }
    );
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { url } = await createSession(secretKey, priceId, baseUrl, null);
  if (!url) {
    return new Response(JSON.stringify({ error: 'Could not create checkout session' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ ok: true, url }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * Ask Stripe for a checkout session and return its URL, or null on any failure.
 *
 * One body for both entrances - the sales page's POST and the comp link's GET - so the
 * tester travels the same session shape a buyer does, minus the price. Errors are logged
 * in full server-side and never leak to the caller.
 */
async function createSession(secretKey, priceId, baseUrl, compCoupon) {
  // A zero-total session needs Stripe API 2023-08-16 or later ("no-cost orders"); this
  // account predates that, so its default version would reject the comp. Pinned on the comp
  // call ONLY - the selling path keeps the exact version that has already taken a real sale,
  // and is not moved for the sake of a tester.
  const versionHeader = compCoupon ? { 'Stripe-Version': '2023-08-16' } : {};
  try {
    let stripeRes = await fetch(STRIPE_CHECKOUT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + secretKey,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...versionHeader,
      },
      body: buildSessionParams(priceId, baseUrl, true, compCoupon).toString(),
    });

    let session = await stripeRes.json();

    // consent_collection fails until the ToS URL is configured in the Stripe
    // Dashboard. Keep checkout alive: retry once without the consent block and
    // log loudly so the missing dashboard setting gets fixed.
    if ((!stripeRes.ok || session.error) && /terms of service/i.test(session.error?.message || '')) {
      console.error('EU ToS consent rejected by Stripe (is the Terms of Service URL set in Dashboard -> Settings -> Business?). Retrying WITHOUT the withdrawal-right waiver:', session.error?.message);
      stripeRes = await fetch(STRIPE_CHECKOUT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + secretKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: buildSessionParams(priceId, baseUrl, false, compCoupon).toString(),
      });
      session = await stripeRes.json();
    }

    if (!stripeRes.ok || session.error) {
      console.error('Stripe checkout session error:', stripeRes.status, session.error || session);
      return { error: session.error?.message || `Stripe returned ${stripeRes.status}` };
    }
    if (!session.url) {
      console.error('Stripe response missing session url:', session);
      return { error: 'Stripe returned a session with no url' };
    }
    return { url: session.url };
  } catch (err) {
    console.error('Failed to create Stripe checkout session:', err);
    return { error: err.message };
  }
}

function serverConfigError() {
  return new Response(JSON.stringify({ error: 'Server configuration error' }), {
    status: 500,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
