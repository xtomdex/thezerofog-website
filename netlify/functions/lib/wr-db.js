// Workshop Room - Supabase access and shared HTTP plumbing.
//
// PostgREST over native fetch, no SDK, matching how create-checkout.js and stripe-webhook.js talk
// to Stripe. Every call here uses SUPABASE_SECRET_KEY, which is the service role: it bypasses RLS.
//
// That is deliberate and it is the whole security model. The baseline migration installs an
// `rls_auto_enable` event trigger that switches RLS on for every new table in `public`, and we
// write NO policies for the wr_* tables. RLS on with no policies means locked to everyone -
// anon and authenticated alike - so the only door into workshop-room data is a function holding
// the secret key. Nothing in the browser can read a registration, an email, or an attendance row.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

export const ALLOWED_ORIGIN = 'https://thezerofog.com';

export const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export function preflight() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

/** Throws if the function cannot possibly work, so the caller fails loudly rather than half-way. */
export function assertDbConfigured() {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SECRET_KEY are not set');
  }
}

async function rest(path, { method = 'GET', body, prefer, query } = {}) {
  assertDbConfigured();

  const url = new URL(`${SUPABASE_URL}/rest/v1/${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    }
  }

  const headers = {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;

  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Supabase ${method} ${path} -> ${res.status}: ${detail.slice(0, 400)}`);
  }

  if (res.status === 204) return null;

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export function select(table, query) {
  return rest(table, { query });
}

export async function selectOne(table, query) {
  const rows = await rest(table, { query: { ...query, limit: 1 } });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export function insert(table, row, { returning = true } = {}) {
  return rest(table, {
    method: 'POST',
    body: row,
    prefer: returning ? 'return=representation' : 'return=minimal',
  });
}

/**
 * Insert-or-update on a named conflict target.
 *
 * `onConflict` must name a real unique constraint. This is the call that makes the heartbeat safe:
 * the player fires one every 20 seconds and may fire two at once on a flaky connection, so the
 * write has to be idempotent rather than additive.
 */
export function upsert(table, row, onConflict, { returning = false } = {}) {
  return rest(table, {
    method: 'POST',
    body: row,
    query: { on_conflict: onConflict },
    prefer: `resolution=merge-duplicates,return=${returning ? 'representation' : 'minimal'}`,
  });
}

export function update(table, query, patch) {
  return rest(table, { method: 'PATCH', query, body: patch, prefer: 'return=minimal' });
}

export function remove(table, query) {
  return rest(table, { method: 'DELETE', query, prefer: 'return=minimal' });
}

/** Calls a Postgres function. Used for the counters that must not race. */
export function rpc(name, args) {
  return rest(`rpc/${name}`, { method: 'POST', body: args });
}

/**
 * A join token: 32 url-safe characters from the system CSPRNG.
 *
 * This is the only thing standing between a stranger and someone else's registration, so it is
 * generated with crypto randomness, never with Math.random. Base64url avoids the characters that
 * get mangled when a link is pasted into an email client.
 */
export function mintToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

/** Constant-time compare, for anywhere a token is checked against a stored value. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Client IP, for rate limiting. Netlify sets x-nf-client-connection-ip; the x-forwarded-for
 * fallback takes the FIRST entry, which is the client - later entries are proxies and are
 * trivially spoofable by the caller.
 */
export function clientIp(req) {
  return (
    req.headers.get('x-nf-client-connection-ip') ||
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  );
}
