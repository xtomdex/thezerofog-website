// Writes a row into public.service_events - our own record that the service was
// actually delivered to a person. Added 2026-08-17.
//
// WHY A FUNCTION AND NOT A DIRECT CLIENT WRITE
//
// This log exists to be shown to a card network when a buyer claims they never got
// anything. A log the subject can write into is not evidence of anything, so
// service_events grants nothing to anon/authenticated - only the secret key reaches it,
// and only through here.
//
// SECURITY - identity comes from the verified session JWT, never the request body,
// exactly as delete-account.js does it. The client sends `Authorization: Bearer
// <user access_token>`; we ask Supabase who it belongs to and use the answer. A caller
// can therefore only ever log events about themselves.
//
// TWO SOURCES, ONE TABLE
//
// This endpoint serves the 'app' source, where we hold a token we can verify. Progress
// read out of the Systeme course area is a separate, deliberately unauthenticated path
// (see course-progress.js) because there is no token of ours on that domain.
//
// Best effort by contract: a failure here must never break the page the customer is
// using. Everything answers 200 except a missing/invalid token.

const ALLOWED_ORIGIN = 'https://thezerofog.com';

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Only these may be recorded. An open `event` field would let a caller write prose
// into what is meant to be a ledger.
const ALLOWED_EVENTS = new Set(['sign_in', 'app_open']);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !secretKey) {
    console.error('[service-log] SUPABASE_URL or SUPABASE_SECRET_KEY not set');
    return json({ ok: false }, 200);
  }

  const authHeader = req.headers.get('authorization') || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  const userToken = m ? m[1].trim() : null;
  if (!userToken) return json({ error: 'Unauthorized' }, 401);

  let body = {};
  try { body = await req.json(); } catch (e) { body = {}; }
  const event = typeof body.event === 'string' ? body.event : '';
  if (!ALLOWED_EVENTS.has(event)) {
    return json({ error: 'Unknown event' }, 400);
  }

  // Verify the token and take BOTH the id and the address from the verified answer.
  let userId = null;
  let email = null;
  try {
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        'apikey': secretKey,
        'Authorization': `Bearer ${userToken}`,
        'User-Agent': 'zerofog-service-log',
      },
    });
    if (!userRes.ok) {
      console.error('[service-log] token verify non-OK:', userRes.status);
      return json({ error: 'Unauthorized' }, 401);
    }
    const user = await userRes.json();
    userId = user && user.id;
    email = user && user.email ? String(user.email).trim().toLowerCase() : null;
  } catch (err) {
    console.error('[service-log] token verify threw:', err && err.message);
    return json({ error: 'Unauthorized' }, 401);
  }
  if (!userId) return json({ error: 'Unauthorized' }, 401);

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/service_events`, {
      method: 'POST',
      headers: {
        'apikey': secretKey,
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        user_id: userId,
        email,
        source: 'app',
        event,
        data: {},
      }),
    });
    if (!res.ok) {
      console.error('[service-log] insert non-OK:', res.status, await res.text());
    }
  } catch (err) {
    console.error('[service-log] insert threw:', err && err.message);
  }

  // Always 200 to the page. The customer's session must not depend on our bookkeeping.
  return json({ ok: true });
}
