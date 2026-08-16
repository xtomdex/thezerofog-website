// Landing-page opt-in. Captures the address BEFORE the visitor reaches the schedule step -
// everyone who drops between the form and picking a session exists only because of this call.
//
// Make.com is out of this path as of 2026-08-16. It used to receive {email, name} on a webhook
// and its scenario did exactly two things: write the lead into a Make data store and create a
// MailerLite subscriber in group `ADs`. Both are done here now, against our own database and
// the MailerLite API we already use everywhere else.
//
// The reason is not the EUR 10/month. Make was a single point of failure on the first step of
// the funnel: a non-2xx from the webhook made this function answer 500, the visitor saw an
// error, and the lead was gone before anything had stored it. That is how the funnel went down
// on 2026-08-13, and how it was losing leads while the scenario sat disabled. The rule here is
// the opposite one: the address is written to two independent places, and it takes BOTH of them
// failing before the visitor is told anything went wrong.

import { upsert, isValidEmail } from './lib/wr-db.js';
import { addListSubscriber } from './lib/wr-mailerlite.js';

const ALLOWED_ORIGIN = 'https://thezerofog.com';

// The MailerLite list the opt-in lead joins. No automation is attached to it, so the join sends
// nothing - the workshop emails are triggered by the wr-* groups after registration. Same group
// the Make scenario wrote to, so the list stays continuous across the switch.
const LEADS_GROUP_ID = process.env.MAILERLITE_LEADS_GROUP_ID || '183307718676711076';

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export default async function handler(req) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { email, name, website, utm } = body;

  // Honeypot: bots fill this field, humans don't
  if (website) {
    // Return 200 silently so bots think they succeeded
    return json({ ok: true });
  }

  if (!isValidEmail(email)) {
    return json({ error: 'A valid email address is required.' }, 400);
  }

  const address = email.trim().toLowerCase();
  const leadName = typeof name === 'string' && name.trim() ? name.trim() : null;

  // The schedule step is ours, so there is no external URL to be missing and no environment
  // variable that can take this function down. Overridable only so a Deploy Preview can point
  // somewhere else; unset is the normal case.
  const scheduleUrl = process.env.WORKSHOP_SCHEDULE_PATH || '/workshop/schedule/';

  const data = {};
  if (utm && typeof utm === 'object') data.utm = utm;
  const referrer = req.headers.get('referer');
  if (referrer) data.referrer = referrer;

  // The upsert merges every column it is given, so a second opt-in from the same address must
  // not carry keys it has no value for - that would blank what the first one recorded.
  const row = { email: address, source: 'optin', updated_at: new Date().toISOString() };
  if (leadName) row.name = leadName;
  if (Object.keys(data).length) row.data = data;

  // Two independent stores, both attempted, neither allowed to abort the other. Supabase is the
  // copy we can query and back-fill from; MailerLite is the one the campaigns are sent from.
  const [db, ml] = await Promise.allSettled([
    upsert('wr_leads', row, 'email'),
    addListSubscriber(address, LEADS_GROUP_ID, { name: leadName }),
  ]);

  if (db.status === 'rejected') {
    console.error('optin: Supabase write failed:', db.reason);
  }
  if (ml.status === 'rejected') {
    console.error('optin: MailerLite subscribe failed:', ml.reason);
  }

  // Only a total loss is worth an error page. If either store took the address we can recover
  // the other side by hand, so the visitor goes on to pick a session.
  if (db.status === 'rejected' && ml.status === 'rejected') {
    return json({ error: 'Upstream error' }, 500);
  }

  // The email is deliberately NOT put in the URL - the client carries it in sessionStorage to
  // the next page, because an address in a query string ends up in browser history, in referrer
  // headers and in any analytics that records paths.
  return json({ ok: true, redirectUrl: scheduleUrl });
}
