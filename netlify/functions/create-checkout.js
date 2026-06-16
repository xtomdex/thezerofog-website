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

export default async function handler(req) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
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

  try {
    // Build the form-encoded body. Stripe expects bracket notation for nested
    // and array params. URLSearchParams encodes the literal {CHECKOUT_SESSION_ID}
    // template braces as %7B...%7D, which Stripe accepts and replaces server-side.
    const params = new URLSearchParams();
    params.set('mode', 'payment');
    params.set('line_items[0][price]', priceId);
    params.set('line_items[0][quantity]', '1');
    params.set('success_url', `${baseUrl}/welcome/?session_id={CHECKOUT_SESSION_ID}`);
    params.set('cancel_url', `${baseUrl}/sales/`);
    // Extensible metadata — a later task can add lead_id/source without restructuring.
    params.set('metadata[source]', 'sales_page');

    const stripeRes = await fetch(STRIPE_CHECKOUT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + secretKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const session = await stripeRes.json();

    // Non-2xx or a Stripe error payload → log detail server-side, return a
    // generic message to the client (never leak Stripe internals).
    if (!stripeRes.ok || session.error) {
      console.error('Stripe checkout session error:', stripeRes.status, session.error || session);
      return new Response(JSON.stringify({ error: 'Could not create checkout session' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!session.url) {
      console.error('Stripe response missing session url:', session);
      return new Response(JSON.stringify({ error: 'Could not create checkout session' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ ok: true, url: session.url }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Failed to create Stripe checkout session:', err);
    return new Response(JSON.stringify({ error: 'Could not create checkout session' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

function serverConfigError() {
  return new Response(JSON.stringify({ error: 'Server configuration error' }), {
    status: 500,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
