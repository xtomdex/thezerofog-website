// Erasure. Deletes the CALLER's own personal data across every system that holds it,
// not just Supabase. Zero dependencies: native fetch, ES-module handler, matching
// create-checkout.js and stripe-webhook.js conventions.
//
// SECURITY — identity comes from the verified session JWT, never the request body.
// The client sends `Authorization: Bearer <user access_token>`. We verify it against
// Supabase (/auth/v1/user) and take the user id AND the email from the verified
// response, so a caller can ONLY ever delete themselves. Nothing in the body is trusted.
//
// ---------------------------------------------------------------------------
// WHY THIS IS NOT ONE DELETE
//
// Until 2026-08-19 this function removed the Supabase auth user and nothing else. The
// cascade on `user_id` took profiles, diary_entries, assessments, protocol_cards and
// recovery_protocol_cards with it — and left behind everything keyed by EMAIL rather
// than by user id: the workshop registration (`wr_registrations`, which carries name,
// token, time zone and UTM, and which cascades to wr_attendance, wr_notifications and
// wr_events), the opt-in lead (`wr_leads`), the MailerLite subscriber and the Systeme
// contact. So a person read "your data is gone" and kept receiving our email.
//
// What each system gets, and why:
//
//   Supabase auth user + cascade    always deleted
//   wr_leads (by email)             always deleted
//   wr_registrations (by email)     always deleted — takes attendance/notifications/events
//   service_events                  deleted only for a NON-buyer. For a buyer it is the
//                                   record that the paid service was actually delivered
//                                   (chargeback defence), and the FK is `on delete set
//                                   null`, so the auth-user delete already unlinks it.
//   MailerLite subscriber           always deleted — this is the one that was still emailing
//   Systeme contact + enrollment    deleted only for a NON-buyer. A buyer paid for that
//                                   course; erasing the contact destroys the thing he bought.
//                                   CEO 2026-08-19: with no refund, access stays.
//   Stripe customer                 never touched — tax law
//   monday buyer row                never deleted (SOP rule 1) — marked, see below
//
// A buyer therefore ends with: no app account, no diary, no workshop registration, no
// marketing email, and his course still open. The client screen says exactly that
// BEFORE he presses, and the two outcomes are different screens.
//
// ---------------------------------------------------------------------------
// FAILURE POLICY
//
// Every external step is best effort and none of them may trap the person inside an
// account he asked to leave — so the auth user is deleted last and regardless. But a
// silent partial erasure is the exact defect this rewrite exists to kill, so anything
// left behind is named in a Telegram alert, with the email, for a human to finish by
// hand. The response carries the same list.

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
  let email = null;
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
    email = (user?.email || '').trim().toLowerCase() || null;
  } catch (err) {
    console.error('[delete-account] token verify error:', err);
    return unauthorized();
  }

  if (!userId) {
    return unauthorized();
  }

  // Did this person pay? The answer decides whether the Systeme contact and the
  // delivery evidence survive, so it is read from the database rather than trusted
  // from the client, which is where the same question is answered for the UI.
  const paid = await isPaidBuyer(supabaseUrl, secretKey, userId);

  // Everything that is not the auth user. Each returns null on success or a short
  // string naming what is still out there.
  const leftBehind = [];
  const note = (what) => { if (what) leftBehind.push(what); };

  if (email) {
    note(await deleteMailerLiteSubscriber(email));
    if (!paid) note(await deleteSystemeContact(email));
    note(await deleteRowsByEmail(supabaseUrl, secretKey, 'wr_leads', email));
    note(await deleteRowsByEmail(supabaseUrl, secretKey, 'wr_registrations', email));
    if (!paid) note(await deleteRowsByEmail(supabaseUrl, secretKey, 'service_events', email));
    if (paid) note(await mondayMarkErased(email));
  } else {
    // An account with no address cannot be looked up anywhere else. Supabase still goes.
    leftBehind.push('no email on the auth user - external systems not searched');
  }

  // Delete the auth user via the admin REST endpoint. Admin call -> secret key in
  // BOTH apikey and Authorization (same value, per the new key format). This
  // cascades to profiles, diary_entries, assessments, protocol_cards and
  // recovery_protocol_cards, and nulls service_events.user_id.
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
      await alertOperator(
        'ERASURE FAILED - the account itself could not be deleted\n\n' +
        `Address: ${email || '(none)'}\n` +
        `Supabase user: ${userId}\n` +
        `Supabase admin delete answered ${delRes.status}.\n` +
        (leftBehind.length ? `Also still out there: ${leftBehind.join('; ')}\n` : '') +
        'The person was told the deletion failed. Finish it by hand or the request is unanswered.'
      );
      return new Response(JSON.stringify({ error: 'Could not delete account' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  } catch (err) {
    console.error('[delete-account] admin delete error:', err);
    await alertOperator(
      'ERASURE FAILED - the account itself could not be deleted\n\n' +
      `Address: ${email || '(none)'}\n` +
      `Supabase user: ${userId}\n` +
      `Error: ${err.message}\n` +
      (leftBehind.length ? `Also still out there: ${leftBehind.join('; ')}\n` : '') +
      'The person was told the deletion failed. Finish it by hand or the request is unanswered.'
    );
    return new Response(JSON.stringify({ error: 'Could not delete account' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // The account is gone. If anything else survived, a person has to finish it, and
  // saying nothing here is how "your data is gone" becomes untrue again.
  if (leftBehind.length) {
    await alertOperator(
      'ERASURE INCOMPLETE - the account is deleted, these are not\n\n' +
      `Address: ${email}\n` +
      `Buyer: ${paid ? 'yes - course access deliberately kept' : 'no'}\n\n` +
      leftBehind.map((x) => `- ${x}`).join('\n') +
      '\n\nDelete these by hand. The person has already been told his data is gone.'
    );
  }

  return new Response(
    JSON.stringify({ deleted: true, courseKept: paid, incomplete: leftBehind.length > 0 }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

/* ------------------------------------------------------------------ Supabase */

/**
 * True only if a profile row exists AND is_paid is true - the same test the app makes
 * before unlocking the paid tools, asked here with the secret key so the client cannot
 * lie its way into keeping a course it never bought.
 *
 * On any failure this answers TRUE. An unreadable profile must not cost somebody the
 * course he paid for; the cost of the wrong answer in the other direction is a Systeme
 * contact and a monday note, both fixable by hand, and the alert names them.
 */
async function isPaidBuyer(supabaseUrl, secretKey, userId) {
  try {
    const url = new URL(`${supabaseUrl}/rest/v1/profiles`);
    url.searchParams.set('user_id', `eq.${userId}`);
    url.searchParams.set('select', 'is_paid');
    const res = await fetch(url, {
      headers: {
        apikey: secretKey,
        Authorization: `Bearer ${secretKey}`,
        'User-Agent': 'zerofog-delete-account',
      },
    });
    if (!res.ok) {
      console.error('[delete-account] is_paid lookup returned', res.status, '- assuming buyer');
      return true;
    }
    const rows = await res.json();
    return !!rows?.[0]?.is_paid;
  } catch (err) {
    console.error('[delete-account] is_paid lookup failed:', err.message, '- assuming buyer');
    return true;
  }
}

/**
 * Delete every row of one table whose `email` column matches. These are the tables keyed
 * by address instead of by user id, which is exactly why the auth-user cascade misses them.
 *
 * `wr_registrations` is the important one: wr_attendance, wr_notifications and wr_events
 * all carry `on delete cascade` from it, so removing the registration takes the whole
 * workshop trail with it in one statement.
 */
async function deleteRowsByEmail(supabaseUrl, secretKey, table, email) {
  try {
    const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
    url.searchParams.set('email', `eq.${email}`);
    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        apikey: secretKey,
        Authorization: `Bearer ${secretKey}`,
        'User-Agent': 'zerofog-delete-account',
        Prefer: 'return=minimal',
      },
    });
    if (!res.ok) {
      console.error(`[delete-account] ${table} delete returned`, res.status, await safeText(res));
      return `Supabase ${table} rows for this address`;
    }
    return null;
  } catch (err) {
    console.error(`[delete-account] ${table} delete failed:`, err.message);
    return `Supabase ${table} rows for this address`;
  }
}

/* ---------------------------------------------------------------- MailerLite */

/**
 * Remove the subscriber outright. Not an unsubscribe: an unsubscribed record still holds
 * the address, the name and every campaign they were sent, which is the data they asked
 * us to erase. MailerLite's DELETE is permanent and answers 204.
 *
 * A missing subscriber is success, not failure - plenty of app accounts never opted in.
 */
async function deleteMailerLiteSubscriber(email) {
  const key = process.env.MAILERLITE_API_KEY;
  if (!key) {
    console.warn('[delete-account] MAILERLITE_API_KEY unset - subscriber not deleted');
    return 'MailerLite subscriber (no API key configured)';
  }
  const base = process.env.MAILERLITE_API_BASE || 'https://connect.mailerlite.com/api';
  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  try {
    // The fetch endpoint takes an id OR an email address in the same position.
    const found = await fetch(`${base}/subscribers/${encodeURIComponent(email)}`, { headers });
    if (found.status === 404) return null; // never subscribed - nothing to erase
    if (!found.ok) {
      console.error('[delete-account] MailerLite lookup returned', found.status);
      return 'MailerLite subscriber';
    }
    const id = (await found.json())?.data?.id;
    if (!id) return null;

    const gone = await fetch(`${base}/subscribers/${id}`, { method: 'DELETE', headers });
    // 404 here means a concurrent delete already did it.
    if (!gone.ok && gone.status !== 404) {
      console.error('[delete-account] MailerLite delete returned', gone.status);
      return 'MailerLite subscriber';
    }
    return null;
  } catch (err) {
    console.error('[delete-account] MailerLite delete failed:', err.message);
    return 'MailerLite subscriber';
  }
}

/* ------------------------------------------------------------------- Systeme */

/**
 * Delete the Systeme contact. NON-BUYERS ONLY - the caller decides, and for a buyer this
 * is never called, because the contact is what holds the course he paid for.
 *
 * Deleting the contact takes its enrollments with it, so there is no separate revoke step
 * here (unlike the refund path in stripe-webhook.js, which must keep the contact and
 * remove one enrollment).
 *
 * No contact is success: a person who only ever used the free app never had one.
 */
async function deleteSystemeContact(email) {
  const key = process.env.SYSTEME_API_KEY;
  if (!key) {
    console.warn('[delete-account] SYSTEME_API_KEY unset - contact not deleted');
    return 'Systeme contact (no API key configured)';
  }
  const base = process.env.SYSTEME_API_BASE || 'https://api.systeme.io/api';
  const headers = {
    'X-API-Key': key,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  try {
    const list = await fetch(`${base}/contacts?email=${encodeURIComponent(email)}`, { headers });
    if (!list.ok) {
      console.error('[delete-account] Systeme contact lookup returned', list.status);
      return 'Systeme contact';
    }
    const data = await list.json();
    const items = data?.items || (Array.isArray(data) ? data : []);
    const contactId = items[0]?.id || null;
    if (!contactId) return null;

    const gone = await fetch(`${base}/contacts/${contactId}`, { method: 'DELETE', headers });
    // 404 = already gone.
    if (!gone.ok && gone.status !== 404) {
      console.error('[delete-account] Systeme contact delete returned', gone.status);
      return `Systeme contact ${contactId}`;
    }
    return null;
  } catch (err) {
    console.error('[delete-account] Systeme delete failed:', err.message);
    return 'Systeme contact';
  }
}

/* -------------------------------------------------------------------- monday */

// The buyer row is never deleted - SOP rule 1, one person one row forever, because a
// deleted row takes the order history with it and the next question about that payment
// has no answer. It is MARKED instead, and the mark has one job: stop anybody sending
// this person a follow-up. `Data erased - do not contact` was added to the Follow-up
// result column on 2026-08-19 (label id 11, dark red - NOT the grey slot 5, which must
// stay blank or it renders on every empty cell).
const MONDAY_API = 'https://api.monday.com/v2';
const MONDAY_BOARD_CUSTOMERS = process.env.MONDAY_BOARD_CUSTOMERS || '5102474399';
const MC = {
  email: 'email_mm6b303d',
  app: 'color_mm6b804g',
  followUpOn: 'date_mm6bbgsn',
  followUpResult: 'color_mm6bggja',
};

async function mondayCall(query, variables) {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) return null;
  const res = await fetch(MONDAY_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: token,
      'API-Version': '2024-10',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    console.error('[monday] HTTP', res.status, await safeText(res));
    return null;
  }
  const body = await res.json();
  if (body.errors) {
    console.error('[monday] API errors:', JSON.stringify(body.errors).slice(0, 400));
    return null;
  }
  return body.data || null;
}

/**
 * Mark a buyer's row: App account -> Deleted, Follow-up result -> Data erased, and the
 * pending follow-up date cleared so the weekly sweep does not schedule a touch to
 * somebody who asked us to forget him.
 *
 * The update is not decoration - SOP rule 3: a status change with no update on the item
 * is the first symptom of a rotting board, and here the update is the only place that
 * records the course was deliberately left open.
 *
 * Returns null when there is nothing to mark: no token (nothing is written anywhere) or
 * no row (a buyer whose row was never created is a separate defect, and the webhook alert
 * already covers it).
 */
async function mondayMarkErased(email) {
  if (!process.env.MONDAY_API_TOKEN) {
    console.warn('[delete-account] MONDAY_API_TOKEN unset - buyer row not marked');
    return 'monday buyer row not marked (no API token configured)';
  }
  try {
    const found = await mondayCall(
      `query ($board: ID!, $col: String!, $val: String!) {
         items_page_by_column_values(board_id: $board, limit: 1,
           columns: [{ column_id: $col, column_values: [$val] }]) { items { id } }
       }`,
      { board: MONDAY_BOARD_CUSTOMERS, col: MC.email, val: email }
    );
    const itemId = found?.items_page_by_column_values?.items?.[0]?.id || null;
    if (!itemId) {
      console.log('[delete-account] no monday row for', email, '- nothing to mark');
      return null;
    }

    const values = {
      [MC.app]: { label: 'Deleted' },
      [MC.followUpResult]: { label: 'Data erased - do not contact' },
      [MC.followUpOn]: {},
    };
    const changed = await mondayCall(
      `mutation ($board: ID!, $item: ID!, $vals: JSON!) {
         change_multiple_column_values(board_id: $board, item_id: $item, column_values: $vals) { id }
       }`,
      { board: MONDAY_BOARD_CUSTOMERS, item: itemId, vals: JSON.stringify(values) }
    );
    if (!changed) return `monday row ${itemId} not marked`;

    const today = new Date().toISOString().slice(0, 10);
    await mondayCall(
      `mutation ($item: ID!, $body: String!) {
         create_update(item_id: $item, body: $body) { id }
       }`,
      {
        item: itemId,
        body:
          `${today} - erasure request, made by the customer in the app.\n\n` +
          'Deleted: app account, sleep diary, assessment history, Protocol Card, ' +
          'workshop registration, opt-in lead, MailerLite subscriber.\n' +
          'Kept on purpose: course access in Systeme (he paid for it and asked for no ' +
          'refund) and the payment record in Stripe (tax law).\n' +
          'Do not send this person anything. There is no address of his left in our email ' +
          'system, and putting one back is the thing he asked us not to do.',
      }
    );
    return null;
  } catch (err) {
    console.error('[delete-account] monday mark failed:', err.message);
    return 'monday buyer row not marked';
  }
}

/* -------------------------------------------------------------------- alerts */

// A copy of stripe-webhook.js's alertOperator rather than an import: this file's contract
// is that it imports nothing at all - it is reachable with only a user token and its
// dependency surface stays empty on purpose.
async function alertOperator(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('alertOperator: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID unset - alert not sent');
    return false;
  }

  const base = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  try {
    // No parse_mode: the body carries an email address a stranger typed, and one unbalanced
    // `_` in Markdown mode makes Telegram reject the whole message. 4096 is the hard limit.
    const res = await fetch(`${base}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text).slice(0, 4096),
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.error('alertOperator: Telegram returned', res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error('alertOperator failed:', err.message);
    return false;
  }
}

/* ------------------------------------------------------------------- replies */

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
