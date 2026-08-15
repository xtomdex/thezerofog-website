// Receives the Systeme.io automation-rule webhook fired on "Course completed" and sends E15,
// the course-complete feedback ask, by adding the finisher to the MailerLite group `wr-E15` -
// the same join-fires-the-automation mechanism as the rest of the funnel transport.
//
// Security: Systeme's "Send webhook" action can neither sign requests nor send custom headers,
// so the rule's URL carries a shared key in the query string (?key=...), compared timing-safe
// against SYSTEME_WEBHOOK_KEY. Unset env or missing/wrong key -> 401, nothing happens. Without
// the key an open endpoint would let anyone spam E15 to arbitrary subscribers.
//
// Payload: Systeme does not document the exact webhook body shape, so the handler walks the
// parsed JSON and takes the first plausible email it finds. The raw top-level keys are logged
// on every call to make the real shape visible in the function log.
//
// The `order` merge field (E15's Tally URL needs ?email=&order=) is looked up best-effort from
// the buyer's Supabase profile (`payment_session_id`, stamped by stripe-webhook.js at
// purchase). A finisher with no profile row still gets E15 - the Tally form works bare.
//
// No remove-before-add on the group join: completing a course twice cannot send a second ask.

import crypto from 'node:crypto';

const baseHeaders = { 'Content-Type': 'application/json' };

function findEmail(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s : null;
  }
  if (typeof value !== 'object') return null;
  // Prefer explicitly named email keys before walking everything else.
  for (const k of Object.keys(value)) {
    if (/email/i.test(k)) {
      const hit = findEmail(value[k], depth + 1);
      if (hit) return hit;
    }
  }
  for (const v of Object.values(value)) {
    const hit = findEmail(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

async function lookupOrder(email) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return '';
  try {
    const endpoint = new URL(`${url}/rest/v1/profiles`);
    endpoint.searchParams.set('email', `eq.${email}`);
    endpoint.searchParams.set('select', 'payment_session_id');
    const res = await fetch(endpoint, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return '';
    const rows = await res.json();
    return rows?.[0]?.payment_session_id || '';
  } catch (err) {
    console.error('E15: order lookup failed:', err.message);
    return '';
  }
}

async function sendCourseCompleteAsk(email) {
  const key = process.env.MAILERLITE_API_KEY;
  if (!key) {
    console.error('E15 skipped: MAILERLITE_API_KEY is not set');
    return;
  }
  const base = process.env.MAILERLITE_API_BASE || 'https://connect.mailerlite.com/api';
  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  try {
    const gRes = await fetch(`${base}/groups?filter[name]=wr-E15`, { headers });
    if (!gRes.ok) {
      console.error('E15: group lookup returned', gRes.status);
      return;
    }
    const gid = ((await gRes.json())?.data || []).find((g) => g.name === 'wr-E15')?.id;
    if (!gid) {
      console.error('E15: no MailerLite group named wr-E15');
      return;
    }

    const order = await lookupOrder(email);
    const up = await fetch(`${base}/subscribers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, fields: { order } }),
    });
    if (!up.ok) {
      console.error('E15: subscriber upsert returned', up.status);
      return;
    }
    const subscriberId = (await up.json())?.data?.id;
    if (!subscriberId) {
      console.error('E15: subscriber upsert returned no id');
      return;
    }

    const add = await fetch(`${base}/subscribers/${subscriberId}/groups/${gid}`, {
      method: 'POST',
      headers,
    });
    if (!add.ok) console.error('E15: group add returned', add.status);
  } catch (err) {
    console.error('sendCourseCompleteAsk failed:', err.message);
  }
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: baseHeaders,
    });
  }

  const expected = process.env.SYSTEME_WEBHOOK_KEY;
  const provided = new URL(req.url).searchParams.get('key') || '';
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected || '', 'utf8');
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: baseHeaders,
    });
  }

  let payload = null;
  try {
    payload = JSON.parse(await req.text());
  } catch {
    console.error('E15: unparseable webhook body');
    return new Response(JSON.stringify({ error: 'Invalid payload' }), {
      status: 400,
      headers: baseHeaders,
    });
  }

  // Make the undocumented Systeme payload shape visible in the log.
  console.log('E15: webhook received, top-level keys:', Object.keys(payload || {}));

  const email = findEmail(payload);
  if (!email) {
    console.error('E15: no email found in webhook payload');
    return new Response(JSON.stringify({ received: true, sent: false }), {
      status: 200,
      headers: baseHeaders,
    });
  }

  await sendCourseCompleteAsk(email);
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: baseHeaders,
  });
}
