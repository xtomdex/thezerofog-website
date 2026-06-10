const ALLOWED_ORIGIN = 'https://thezerofog.com';

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export default async function handler(req) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { email, name, website } = body;

  // Honeypot: bots fill this field, humans don't
  if (website) {
    // Return 200 silently so bots think they succeeded
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!isValidEmail(email)) {
    return new Response(JSON.stringify({ error: 'A valid email address is required.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const webhookUrl = process.env.MAKE_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error('MAKE_WEBHOOK_URL environment variable is not set');
    return new Response(JSON.stringify({ error: 'Server configuration error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const scheduleUrl = process.env.EVERWEBINAR_SCHEDULE_URL;
  if (!scheduleUrl) {
    console.error('EVERWEBINAR_SCHEDULE_URL environment variable is not set');
    return new Response(JSON.stringify({ error: 'Server configuration error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const payload = { email: email.trim() };
  if (name && typeof name === 'string' && name.trim()) {
    payload.name = name.trim();
  }

  try {
    const upstream = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      console.error('Make.com webhook returned', upstream.status);
      throw new Error('Upstream error');
    }

    // Lead accepted by Make. Return the EverWebinar schedule URL as-is. EverWebinar
    // URL prefill is unsupported, so we do NOT append the email here. The client
    // appends UTM params (from the landing-page URL) before redirecting.
    return new Response(JSON.stringify({ ok: true, redirectUrl: scheduleUrl }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Failed to forward to Make.com:', err);
    return new Response(JSON.stringify({ error: 'Upstream error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}
