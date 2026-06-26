// Deletes the CALLER's own Supabase account (right to erasure). Zero dependencies:
// native fetch, ES-module handler, matching create-checkout.js conventions.
//
// SECURITY — identity comes from the verified session JWT, never the request body.
// The client sends `Authorization: Bearer <user access_token>`. We verify it against
// Supabase (/auth/v1/user) and take the user_id from the verified response, so a caller
// can ONLY ever delete themselves. Nothing in the request body is trusted for identity.
//
// Deleting the auth user cascades to profiles, diary_entries and assessments
// (on delete cascade on user_id). The client also deletes its own diary/assessment
// rows first (belt-and-suspenders); this server step removes the auth user + profile.

const ALLOWED_ORIGIN = 'https://thezerofog.com';

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

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
  const supabaseUrl = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl) {
    console.error('SUPABASE_URL environment variable is not set');
    return serverConfigError();
  }
  if (!secretKey) {
    console.error('SUPABASE_SECRET_KEY environment variable is not set');
    return serverConfigError();
  }

  // Read the caller's bearer token from the Authorization header. Identity is
  // derived from THIS token (verified below), not from any request-body field.
  const authHeader = req.headers.get('authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const userToken = match ? match[1].trim() : null;
  if (!userToken) {
    return unauthorized();
  }

  // Verify the token by asking Supabase who it belongs to. Here Authorization
  // carries the USER's JWT (correct usage), while apikey carries the secret key.
  // User-Agent is non-browser to avoid the new-key 401-on-browser rejection.
  let userId = null;
  try {
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      method: 'GET',
      headers: {
        'apikey': secretKey,
        'Authorization': `Bearer ${userToken}`,
        'User-Agent': 'zerofog-delete-account',
      },
    });
    if (!userRes.ok) {
      console.error('[delete-account] token verify non-OK:', userRes.status);
      return unauthorized();
    }
    const user = await userRes.json();
    userId = user?.id || null;
  } catch (err) {
    console.error('[delete-account] token verify error:', err);
    return unauthorized();
  }

  if (!userId) {
    return unauthorized();
  }

  // Delete the auth user via the admin REST endpoint. Admin call → secret key in
  // BOTH apikey and Authorization (same value, per the new key format). This
  // cascades to profiles, diary_entries and assessments.
  try {
    const delRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: {
        'apikey': secretKey,
        'Authorization': `Bearer ${secretKey}`,
        'User-Agent': 'zerofog-delete-account',
      },
    });
    if (!delRes.ok) {
      console.error('[delete-account] admin delete non-OK:', delRes.status, await safeText(delRes));
      return new Response(JSON.stringify({ error: 'Could not delete account' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  } catch (err) {
    console.error('[delete-account] admin delete error:', err);
    return new Response(JSON.stringify({ error: 'Could not delete account' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ deleted: true }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function unauthorized() {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function serverConfigError() {
  return new Response(JSON.stringify({ error: 'Server configuration error' }), {
    status: 500,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// small helper so logging a non-OK body can't throw
async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
