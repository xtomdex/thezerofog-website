// Receives Stripe `checkout.session.completed` webhooks, verifies the Stripe
// signature (native crypto HMAC-SHA256 — no Stripe SDK / no npm dependencies),
// validates the payment (paid + expected amount + expected currency), and enrolls
// the buyer into the Systeme.io course directly (find-or-create contact, then
// create enrollment). Make is out of the payment path since 2026-08-16 — its
// Payment Processing scenario (6209692) stays permanently off; this handler is
// the single consumer of Stripe events. The purchase-welcome email (E14) is the
// one email sent from here, via MailerLite directly — Make has been out of the
// email path since 2026-08-14. A full refund runs the same path backwards: the buyer's
// Systeme enrollment is deleted, they are tagged `refunded`, and they lose `is_paid`
// in the app.
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

/**
 * Tell the operator, over Telegram, that a paid order did not fully land.
 *
 * Everything below this line that can fail on a real customer used to fail into `console.error`
 * and nowhere else, which means into a Netlify log nobody opens. The failures are not
 * hypothetical and they are not equal: an enrollment that never happened is a person who paid
 * and has no course; a revocation that never happened is a person whose money went back while
 * their access stayed open. Both need a human the same hour, and neither has any other way of
 * reaching one.
 *
 * A duplicate of `notifyOperator` in lib/wr-telegram.js rather than an import, and deliberately.
 * This file's stated contract is that it imports nothing but node:crypto - it is the one endpoint
 * an attacker can reach without a token, and its dependency surface is kept minimal on purpose.
 * The same reason already produced bare-fetch copies of the Supabase and MailerLite calls here.
 *
 * Costs the happy path nothing: every call site is inside a failure branch, so a successful order
 * still makes exactly the network calls it made before. Never throws, and never changes a
 * response - an alert that fails is a notification lost, never a payment reprocessed.
 */
/**
 * How a person is named in an alert. The address alone answers "who paid" and not "who am I
 * writing back to" - and since 2026-08-19 the schedule step asks for a first name, so most
 * people arrive with one. Falls back to the bare address, which is what every alert carried
 * before, so nothing is lost when Stripe hands us no name.
 */
function who(email, name) {
  const n = (name || '').trim();
  return n ? `${n} <${email}>` : String(email || '(no address)');
}

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
    // `_` in Markdown mode makes Telegram reject the whole message. Plain text cannot be
    // broken by its own content. 4096 is Telegram's hard limit.
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

/**
 * Stamp `purchased_at` on this person's workshop registration, if they have one.
 *
 * Written with a bare fetch rather than through lib/wr-db.js so this handler keeps its property
 * of importing nothing but node:crypto — it is the one endpoint an attacker can reach without a
 * token, and its dependency surface is deliberately minimal.
 *
 * Swallows every error. A paid order must never fail because a follow-up flag did not save.
 */
/**
 * Enroll the buyer into the Systeme.io course — the step that actually opens the product.
 * Mirrors what Make's Payment Processing scenario (6209692, now permanently off) did:
 * find the contact by email, create it if missing, then create a full_access enrollment
 * into the course. Same bare-fetch/no-imports contract as everything else in this file.
 *
 * Idempotency: Systeme rejects a duplicate enrollment with a 4xx, and this function treats
 * any 4xx from the enrollment call as "already enrolled" — a duplicate Stripe delivery or a
 * retry after a partial failure cannot produce a second enrollment or an error loop. (Make's
 * scenario used an Ignore error handler on the same call for the same reason.)
 *
 * Returns the Systeme CONTACT ID when the buyer is enrolled (or already was), and null on a
 * transient failure — the caller answers Stripe with 500 in that case so the event is retried. A
 * paid order must never be silently dropped: no course access without either an enrollment or a
 * Stripe retry. The id is returned rather than a bare true because the operations board links
 * straight to the student's Systeme page, and this is the only place that id is known.
 */
async function enrollInCourse(email) {
  const key = process.env.SYSTEME_API_KEY;
  const courseId = process.env.SYSTEME_COURSE_ID || '606107';
  const base = process.env.SYSTEME_API_BASE || 'https://api.systeme.io/api';
  const headers = {
    'X-API-Key': key,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const normalized = email.trim().toLowerCase();

  try {
    // 1) Find the contact by email.
    let contactId = null;
    const list = await fetch(`${base}/contacts?email=${encodeURIComponent(normalized)}`, {
      headers,
    });
    if (list.ok) {
      const data = await list.json();
      const items = data?.items || (Array.isArray(data) ? data : []);
      contactId = items[0]?.id || null;
    } else {
      console.error('enroll: contact lookup returned', list.status);
      return null;
    }

    // 2) Create the contact if it does not exist. A 4xx here means a concurrent
    //    request created it first — look it up again rather than failing the order.
    if (!contactId) {
      const created = await fetch(`${base}/contacts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: normalized, locale: 'en' }),
      });
      if (created.ok) {
        contactId = (await created.json())?.id || null;
      } else if (created.status >= 400 && created.status < 500) {
        const retry = await fetch(
          `${base}/contacts?email=${encodeURIComponent(normalized)}`,
          { headers }
        );
        if (retry.ok) {
          const data = await retry.json();
          const items = data?.items || (Array.isArray(data) ? data : []);
          contactId = items[0]?.id || null;
        }
      }
      if (!contactId) {
        console.error('enroll: could not create or find contact for paid order');
        return null;
      }
    }

    // 3) Create the enrollment. 2xx = enrolled; 4xx = already enrolled (idempotent
    //    success); anything else = transient, let Stripe retry.
    const enroll = await fetch(`${base}/school/courses/${courseId}/enrollments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ contactId, accessType: 'full_access' }),
    });
    if (enroll.ok) return contactId;
    if (enroll.status >= 400 && enroll.status < 500) {
      console.log('enroll: enrollment call returned', enroll.status, '- treating as already enrolled');
      return contactId;
    }
    console.error('enroll: enrollment call returned', enroll.status);
    return null;
  } catch (err) {
    console.error('enrollInCourse failed:', err.message);
    return null;
  }
}

/**
 * Close the course after a refund: delete the buyer's enrollment in Systeme.io outright.
 *
 * The delete route is NOT under the course — `/school/courses/{id}/enrollments` takes POST only,
 * which is what makes it look like enrollments cannot be removed. It lives one level up:
 * `GET /school/enrollments?contact={id}` lists them and `DELETE /school/enrollments/{id}` removes
 * one (both verified against the live API 2026-08-16). A deleted enrollment stays in the listing
 * with `active: false`.
 *
 * The `refunded` tag is still applied afterwards, best effort, for two reasons: it is the record
 * of who was refunded, and it fires the Systeme `Refunded` workflow, which revokes course access
 * a second time. That redundancy is deliberate and free — revoking an already-revoked enrollment
 * changes nothing, and it means access still closes if this handler ever loses its API key.
 *
 * Does NOT create the contact: no contact means no enrollment, and there is nothing to revoke.
 * Returns true once every matching enrollment is gone (or there was nothing to remove), false on
 * a transient failure — the caller answers 500 so Stripe retries rather than leaving a refunded
 * buyer with an open course.
 */
async function revokeCourseAccess(email) {
  const key = process.env.SYSTEME_API_KEY;
  const courseId = String(process.env.SYSTEME_COURSE_ID || '606107');
  const tagId = Number(process.env.SYSTEME_REFUNDED_TAG_ID || '2134135');
  const base = process.env.SYSTEME_API_BASE || 'https://api.systeme.io/api';
  const headers = {
    'X-API-Key': key,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const normalized = email.trim().toLowerCase();

  try {
    const list = await fetch(`${base}/contacts?email=${encodeURIComponent(normalized)}`, {
      headers,
    });
    if (!list.ok) {
      console.error('refund: contact lookup returned', list.status);
      return false;
    }
    const data = await list.json();
    const items = data?.items || (Array.isArray(data) ? data : []);
    const contactId = items[0]?.id || null;
    if (!contactId) {
      console.log('refund: no Systeme contact for', normalized, '- nothing to revoke');
      return true;
    }

    // Only this contact's enrollments — the endpoint ignores every other filter name, so a
    // wrong parameter silently returns the whole account and we would delete other people's
    // access. `contact` is the one that filters (verified).
    const enrolled = await fetch(`${base}/school/enrollments?contact=${contactId}&limit=100`, {
      headers,
    });
    if (!enrolled.ok) {
      console.error('refund: enrollment lookup returned', enrolled.status);
      return false;
    }
    const rows = (await enrolled.json())?.items || [];
    const mine = rows.filter(
      (r) => String(r?.course?.id) === courseId && r?.active !== false && r?.contact?.id === contactId
    );

    for (const row of mine) {
      const gone = await fetch(`${base}/school/enrollments/${row.id}`, {
        method: 'DELETE',
        headers,
      });
      // 4xx = already gone (a duplicate Stripe delivery, or a second refund on the same charge).
      if (!gone.ok && !(gone.status >= 400 && gone.status < 500)) {
        console.error('refund: enrollment delete returned', gone.status, 'for', row.id);
        return false;
      }
    }
    console.log('refund: revoked', mine.length, 'enrollment(s) for', normalized);

    // The record, and the second line of defence. Never fails the revocation: the course is
    // already closed by the time this runs.
    try {
      await fetch(`${base}/contacts/${contactId}/tags`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tagId }),
      });
    } catch (err) {
      console.error('refund: tagging failed (ignored):', err.message);
    }

    return true;
  } catch (err) {
    console.error('revokeCourseAccess failed:', err.message);
    return false;
  }
}

/**
 * Close the Toolkit after a refund: flip `is_paid` back to false on the buyer's profile.
 *
 * Systeme knows nothing about our app, so revoking the course leaves /app wide open unless this
 * runs too. The auth user itself is left alone — deleting it would take the person's diary
 * entries with it, and a refunder who buys again should land back in their own data.
 *
 * Deliberately does NOT clear `purchased_at` on the workshop registration: that column is the
 * buyer guard wr-notify.js reads before every send, and clearing it would put a person who just
 * asked for their money back into the sales sequence again.
 *
 * Best effort, never throws — the course is already closed by the time this runs.
 */
async function revokeAppAccess(email) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key || !email) return;

  try {
    const endpoint = new URL(`${url}/rest/v1/profiles`);
    endpoint.searchParams.set('email', `eq.${email.trim().toLowerCase()}`);

    const res = await fetch(endpoint, {
      method: 'PATCH',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'User-Agent': 'zerofog-stripe-webhook',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ is_paid: false }),
    });

    if (!res.ok) {
      console.error('revokeAppAccess: Supabase returned', res.status);
    }
  } catch (err) {
    console.error('revokeAppAccess failed:', err.message);
  }
}

async function markWorkshopBuyer(email) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key || !email) return;

  try {
    const endpoint = new URL(`${url}/rest/v1/wr_registrations`);
    endpoint.searchParams.set('email', `eq.${email.trim().toLowerCase()}`);

    const res = await fetch(endpoint, {
      method: 'PATCH',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ purchased_at: new Date().toISOString() }),
    });

    if (!res.ok) {
      console.error('markWorkshopBuyer: Supabase returned', res.status);
    }
  } catch (err) {
    console.error('markWorkshopBuyer failed:', err.message);
  }
}

/**
 * Send the server-side Meta Purchase twin over the Conversions API.
 *
 * Written with bare fetch for the same reason as sendPurchaseWelcome below: this handler keeps
 * its import surface at node:crypto only (the canonical sender lives in lib/meta-capi.js and the
 * funnel functions use it; this is a deliberate inline twin, same as the MailerLite one).
 *
 * The browser pixel on /welcome/ fires Purchase with eventID = this same checkout session id
 * (cookie-consent-5.js), so Meta collapses the pair; when the buyer's browser blocks the pixel -
 * the common case - this call is the only Purchase Meta ever sees.
 *
 * Best effort, never throws: unset env is a silent no-op, and a failed ad-platform call must
 * never 500 a correctly processed payment.
 */
async function sendMetaPurchase(email, session) {
  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_TOKEN;
  if (!pixelId || !token || !email) return;

  const em = crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  const body = {
    data: [
      {
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: session.id,
        action_source: 'website',
        event_source_url: `${process.env.PUBLIC_SITE_URL || 'https://thezerofog.com'}/welcome/`,
        user_data: { em: [em] },
        custom_data: {
          value: Number(session.amount_total || 0) / 100,
          currency: String(session.currency || 'usd').toUpperCase(),
        },
      },
    ],
  };
  if (process.env.META_CAPI_TEST_CODE) body.test_event_code = process.env.META_CAPI_TEST_CODE;

  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${encodeURIComponent(token)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`meta purchase event: ${res.status}: ${detail.slice(0, 300)}`);
    }
  } catch (err) {
    console.error('meta purchase event failed:', err.message);
  }
}

/**
 * Send E14, the purchase-welcome email, by adding the buyer to the MailerLite group `wr-E14` —
 * the same join-fires-the-automation mechanism the whole workshop funnel uses (lib/wr-mailerlite.js).
 *
 * Written with bare fetch for the same reason as markWorkshopBuyer: this handler keeps its
 * import surface at node:crypto only. Two deliberate differences from the funnel transport:
 * no merge fields (E14's body needs none), and NO remove-before-add — adding an existing group
 * member fires no join, so a duplicate Stripe delivery cannot double-send the welcome.
 *
 * Best effort, never throws: a failed welcome email must not 500 a correctly processed payment
 * (Stripe would retry the whole event). A failure lands in the function log and support fixes it.
 *
 * Returns true only when MailerLite accepted the group add - the caller alerts the operator on
 * false, because a buyer with no welcome email has no idea what they just bought or where it is.
 */
async function sendPurchaseWelcome(email) {
  const key = process.env.MAILERLITE_API_KEY;
  if (!key || !email) {
    if (!key) console.error('E14 skipped: MAILERLITE_API_KEY is not set');
    return false;
  }
  const base = process.env.MAILERLITE_API_BASE || 'https://connect.mailerlite.com/api';
  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  try {
    const gRes = await fetch(`${base}/groups?filter[name]=wr-E14`, { headers });
    if (!gRes.ok) {
      console.error('E14: group lookup returned', gRes.status);
      return false;
    }
    const groups = (await gRes.json())?.data || [];
    const gid = groups.find((g) => g.name === 'wr-E14')?.id;
    if (!gid) {
      console.error('E14: no MailerLite group named wr-E14');
      return false;
    }

    const up = await fetch(`${base}/subscribers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: email.trim().toLowerCase() }),
    });
    if (!up.ok) {
      console.error('E14: subscriber upsert returned', up.status);
      return false;
    }
    const subscriberId = (await up.json())?.data?.id;
    if (!subscriberId) {
      console.error('E14: subscriber upsert returned no id');
      return false;
    }

    const add = await fetch(`${base}/subscribers/${subscriberId}/groups/${gid}`, {
      method: 'POST',
      headers,
    });
    if (!add.ok) {
      console.error('E14: group add returned', add.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error('sendPurchaseWelcome failed:', err.message);
    return false;
  }
}

/**
 * Send E18, the abandoned-checkout recovery note, by adding the person to the MailerLite group
 * `wr-E18`. Same bare-fetch/no-imports contract as sendPurchaseWelcome above.
 *
 * Guards, in order:
 * - Buyers are skipped: anyone already in `wr-E14` paid (possibly in a second checkout session
 *   while this one quietly expired) and must never get a recovery nudge.
 * - No remove-before-add: if the address is already in wr-E18 from an earlier abandonment, the
 *   add fires no join and no second email — "this is the only nudge I'll send" is enforced here,
 *   not just in the automation's re-enter setting.
 *
 * Best effort, never throws: a lost recovery email is a log line, not a Stripe retry.
 */
async function sendAbandonedCheckout(email) {
  const key = process.env.MAILERLITE_API_KEY;
  if (!key || !email) {
    if (!key) console.error('E18 skipped: MAILERLITE_API_KEY is not set');
    return;
  }
  const base = process.env.MAILERLITE_API_BASE || 'https://connect.mailerlite.com/api';
  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const normalized = email.trim().toLowerCase();

  try {
    // Skip buyers: an existing subscriber sitting in wr-E14 already purchased.
    const existing = await fetch(
      `${base}/subscribers/${encodeURIComponent(normalized)}`,
      { headers }
    );
    if (existing.ok) {
      const groups = (await existing.json())?.data?.groups || [];
      if (groups.some((g) => g.name === 'wr-E14')) {
        console.log('E18 skipped: buyer', normalized);
        return;
      }
    }

    const gRes = await fetch(`${base}/groups?filter[name]=wr-E18`, { headers });
    if (!gRes.ok) {
      console.error('E18: group lookup returned', gRes.status);
      return;
    }
    const gid = ((await gRes.json())?.data || []).find((g) => g.name === 'wr-E18')?.id;
    if (!gid) {
      console.error('E18: no MailerLite group named wr-E18');
      return;
    }

    const up = await fetch(`${base}/subscribers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: normalized }),
    });
    if (!up.ok) {
      console.error('E18: subscriber upsert returned', up.status);
      return;
    }
    const subscriberId = (await up.json())?.data?.id;
    if (!subscriberId) {
      console.error('E18: subscriber upsert returned no id');
      return;
    }

    const add = await fetch(`${base}/subscribers/${subscriberId}/groups/${gid}`, {
      method: 'POST',
      headers,
    });
    if (!add.ok) console.error('E18: group add returned', add.status);
  } catch (err) {
    console.error('sendAbandonedCheckout failed:', err.message);
  }
}

// Minimal headers kept for consistency with the other functions. Stripe does not
// send a CORS preflight, so no OPTIONS handling is required here.
const baseHeaders = {
  'Content-Type': 'application/json',
};

// ---------------------------------------------------------------------------
// monday.com operations board
//
// Every paid order and every refund is written to two boards: `ZeroFog - Customers`
// (one row per buyer, carrying whether they actually got access) and `ZeroFog - Money`
// (one row per money event). Before this, the only record that a person bought was
// spread across Stripe, Systeme and Supabase, and a failed enrollment was a line in a
// Netlify log that nobody reads.
//
// Contract, same as everything else in this file: bare fetch, no imports, and
// BEST EFFORT ONLY. A bookkeeping board must never decide whether a paid order
// succeeds, so every function here swallows its errors and returns quietly. If
// MONDAY_API_TOKEN is not set the whole thing is a no-op — that is deliberate, so
// this code can ship before the token exists.
//
// Idempotency matters because Stripe retries: the buyer row is looked up by email
// before it is created, and the money row is looked up by its Stripe id. A retried
// event updates the same two rows instead of growing duplicates.
const MONDAY_API = 'https://api.monday.com/v2';
const MONDAY_BOARD_CUSTOMERS = process.env.MONDAY_BOARD_CUSTOMERS || '5102474399';
const MONDAY_BOARD_MONEY = process.env.MONDAY_BOARD_MONEY || '5102474401';

// Column ids as created on 2026-08-18. They are stable for the life of the board;
// if a column is ever recreated in the UI its id changes and these must be updated.
const MC = {
  email: 'email_mm6b303d',
  bought: 'date_mm6b9tq0',
  product: 'color_mm6b613s',
  paid: 'numeric_mm6b153p',
  payment: 'color_mm6bnx6y',
  access: 'color_mm6brrbj',
  app: 'color_mm6b804g',
  refundedOn: 'date_mm6bxg4g',
  stripeCustomer: 'text_mm6br1nv',
  systeme: 'link_mm6b13pt',
  progress: 'color_mm6bxg81',
  refundStage: 'color_mm6b7dhw',
  issue: 'color_mm6bf9at',
};

// Groups on the Customers board. A row's group is where the eye goes first, so the webhook puts
// buyers where they belong and never leaves a refunded person sitting among the active ones.
const MG = { active: 'topics', refundInProgress: 'group_mm6bsmhn', internal: 'group_mm6bxbfd' };
const MM = {
  type: 'color_mm6bzp4h',
  date: 'date_mm6bdy5x',
  charged: 'numeric_mm6bffv',
  currency: 'text_mm6brn15',
  stripeId: 'text_mm6bxe8v',
  liveMode: 'color_mm6bma3q',
  note: 'long_text_mm6bm1t2',
  customer: 'board_relation_mm6bwy62',
};

async function mondayCall(query, variables) {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) return null;
  try {
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
  } catch (err) {
    console.error('[monday] request error:', err);
    return null;
  }
}

// Find one item by an exact value in a text-ish column. Returns its id or null.
async function mondayFindItem(boardId, columnId, value) {
  const data = await mondayCall(
    `query ($board: ID!, $col: String!, $val: String!) {
       items_page_by_column_values(board_id: $board, limit: 1,
         columns: [{ column_id: $col, column_values: [$val] }]) { items { id } }
     }`,
    { board: boardId, col: columnId, val: value }
  );
  return data?.items_page_by_column_values?.items?.[0]?.id || null;
}

function mondayProductLabel(amountCents) {
  const dollars = Math.round(Number(amountCents || 0) / 100);
  if (dollars === 67) return 'Course $67';
  if (dollars === 167) return 'Course $167';
  if (dollars === 250) return 'Course $250';
  return 'Other';
}

/**
 * Record a paid order. Creates the buyer row if this email has never bought before,
 * otherwise updates it, and adds one Charge row to the money board.
 *
 * `appProvisioned` is what actually happened, not what we hoped: the board is only
 * useful if it shows the gap between "paid" and "has access".
 */
async function mondayRecordPurchase(details) {
  if (!process.env.MONDAY_API_TOKEN) return;
  const { email, name, amountCents, currency, sessionId, chargeOrIntentId,
          customerId, systemeContactId, appProvisioned, livemode, comp } = details;
  const today = new Date().toISOString().slice(0, 10);
  const dollars = Number(amountCents || 0) / 100;

  const customerValues = {
    [MC.email]: { email, text: email },
    [MC.bought]: { date: today },
    [MC.product]: { label: comp ? 'Other' : mondayProductLabel(amountCents) },
    [MC.paid]: String(dollars),
    [MC.payment]: { label: comp ? 'Comped' : 'Paid' },
    [MC.access]: { label: 'Enrolled' },
    [MC.app]: { label: appProvisioned ? 'Provisioned' : 'Missing' },
    [MC.stripeCustomer]: customerId || '',
    [MC.progress]: { label: 'Not started' },
    [MC.refundStage]: { label: 'None' },
    [MC.issue]: { label: 'None' },
  };
  // The link to the student's own Systeme page. Mandatory on every row: without it, answering
  // "did this person actually get the course" means searching Systeme by hand.
  if (systemeContactId) {
    customerValues[MC.systeme] = {
      url: `https://systeme.io/dashboard/contacts/${systemeContactId}`,
      text: `Systeme contact ${systemeContactId}`,
    };
  }

  let itemId = await mondayFindItem(MONDAY_BOARD_CUSTOMERS, MC.email, email);
  if (itemId) {
    await mondayCall(
      `mutation ($board: ID!, $item: ID!, $vals: JSON!) {
         change_multiple_column_values(board_id: $board, item_id: $item, column_values: $vals) { id }
       }`,
      { board: MONDAY_BOARD_CUSTOMERS, item: itemId, vals: JSON.stringify(customerValues) }
    );
  } else {
    const created = await mondayCall(
      `mutation ($board: ID!, $group: String!, $name: String!, $vals: JSON!) {
         create_item(board_id: $board, group_id: $group, item_name: $name, column_values: $vals,
                     create_labels_if_missing: true) { id }
       }`,
      {
        board: MONDAY_BOARD_CUSTOMERS,
        // A comped seat is not a customer and must never be counted as one - SOP, the group
        // that exists because the first charge this business took was Dima's own.
        group: comp ? MG.internal : MG.active,
        name: name ? `${email} - ${name}` : email,
        vals: JSON.stringify(customerValues),
      }
    );
    itemId = created?.create_item?.id || null;
  }

  // A comp moves no euros, so it gets no money row. A zero-value Charge on the ledger would
  // have to be excluded by hand from every sum computed off that board later.
  if (comp) return;

  // The money row. Fees are deliberately left empty: the webhook payload does not carry
  // them, they only exist on the balance transaction once Stripe has settled the charge.
  const moneyKey = chargeOrIntentId || sessionId;
  if (moneyKey && (await mondayFindItem(MONDAY_BOARD_MONEY, MM.stripeId, moneyKey))) return;

  const moneyValues = {
    [MM.type]: { label: 'Charge' },
    [MM.date]: { date: today },
    [MM.charged]: String(dollars),
    [MM.currency]: String(currency || '').toUpperCase(),
    [MM.stripeId]: moneyKey || '',
    [MM.liveMode]: { label: livemode ? 'Live' : 'Test' },
    [MM.note]: 'Written by stripe-webhook. Stripe fee and net settled are empty on purpose - they live on the balance transaction and are only known after settlement.',
  };
  if (itemId) moneyValues[MM.customer] = { item_ids: [Number(itemId)] };

  await mondayCall(
    `mutation ($board: ID!, $name: String!, $vals: JSON!) {
       create_item(board_id: $board, item_name: $name, column_values: $vals,
                   create_labels_if_missing: true) { id }
     }`,
    {
      board: MONDAY_BOARD_MONEY,
      name: `Charge $${dollars} - ${email}`,
      vals: JSON.stringify(moneyValues),
    }
  );
}

/**
 * Record a refund: flip the buyer's row to Refunded/Revoked and add a NEGATIVE money row.
 * The negative is the convention the board's dashboard sums depend on - a refund entered
 * as a positive number would read as revenue.
 */
async function mondayRecordRefund(details) {
  if (!process.env.MONDAY_API_TOKEN) return;
  const { email, chargeId, amountRefundedCents, currency, livemode } = details;
  const today = new Date().toISOString().slice(0, 10);
  const dollars = Number(amountRefundedCents || 0) / 100;

  const itemId = await mondayFindItem(MONDAY_BOARD_CUSTOMERS, MC.email, email);
  if (itemId) {
    await mondayCall(
      `mutation ($board: ID!, $item: ID!, $vals: JSON!) {
         change_multiple_column_values(board_id: $board, item_id: $item, column_values: $vals) { id }
       }`,
      {
        board: MONDAY_BOARD_CUSTOMERS,
        item: itemId,
        vals: JSON.stringify({
          [MC.payment]: { label: 'Refunded' },
          [MC.access]: { label: 'Revoked' },
          [MC.app]: { label: 'Missing' },
          [MC.refundedOn]: { date: today },
          // "Sent", not "Closed - refunded": the money has left Stripe, but the row is only
          // closed by a human after the client confirms they got it. That last step is the one
          // that stops a refund from quietly turning into a chargeback.
          [MC.refundStage]: { label: 'Sent' },
        }),
      }
    );
    await mondayCall(
      // move_item_to_group takes no board_id - passing one is a hard GraphQL error, not a warning.
      `mutation ($item: ID!, $group: String!) {
         move_item_to_group(item_id: $item, group_id: $group) { id }
       }`,
      { item: itemId, group: MG.refundInProgress }
    );
  } else {
    console.warn('[monday] refund for an email with no buyer row:', email);
  }

  const refundKey = `refund:${chargeId}`;
  if (await mondayFindItem(MONDAY_BOARD_MONEY, MM.stripeId, refundKey)) return;

  const values = {
    [MM.type]: { label: 'Refund' },
    [MM.date]: { date: today },
    [MM.charged]: String(-Math.abs(dollars)),
    [MM.currency]: String(currency || '').toUpperCase(),
    [MM.stripeId]: refundKey,
    [MM.liveMode]: { label: livemode ? 'Live' : 'Test' },
    [MM.note]: 'Written by stripe-webhook on charge.refunded. Entered negative on purpose so the dashboard sums stay true.',
  };
  if (itemId) values[MM.customer] = { item_ids: [Number(itemId)] };

  await mondayCall(
    `mutation ($board: ID!, $name: String!, $vals: JSON!) {
       create_item(board_id: $board, item_name: $name, column_values: $vals,
                   create_labels_if_missing: true) { id }
     }`,
    { board: MONDAY_BOARD_MONEY, name: `Refund $${dollars} - ${email}`, vals: JSON.stringify(values) }
  );
}

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
  const systemeApiKey = process.env.SYSTEME_API_KEY;
  const expectedAmount = process.env.EXPECTED_AMOUNT_TOTAL;
  const expectedCurrency = process.env.EXPECTED_CURRENCY;

  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET environment variable is not set');
    return serverConfigError();
  }
  if (!systemeApiKey) {
    console.error('SYSTEME_API_KEY environment variable is not set');
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

  // An abandoned checkout: the session expired (create-checkout.js sets a 2h
  // expires_at) with an email captured and no payment. Sends E18, the single
  // recovery note, via the same join-fires-the-automation mechanism as E14.
  // Always acknowledged with 200 — a recovery email is never worth a Stripe retry.
  if (event.type === 'checkout.session.expired') {
    const expired = event.data?.object || {};
    const abandonedEmail =
      expired.customer_details?.email || expired.customer_email || null;
    if (abandonedEmail && expired.payment_status !== 'paid') {
      await sendAbandonedCheckout(abandonedEmail);
    }
    return received();
  }

  // A refund. Fires when the money is actually back with the customer — NOT when someone asks
  // for it. That is the point: support tries to keep the customer first, and access only closes
  // once the refund is really issued.
  //
  // Full refunds only. Stripe sets `refunded: true` on the charge exactly when the whole amount
  // is back; a partial refund (a goodwill gesture, a duplicate charge fixed) leaves it false and
  // must not take the course away.
  if (event.type === 'charge.refunded') {
    const charge = event.data?.object || {};
    if (charge.refunded !== true) {
      console.log('refund: partial refund on', charge.id, '- access left open');
      return received();
    }

    const refundedEmail =
      charge.billing_details?.email || charge.receipt_email || null;
    if (!refundedEmail) {
      // Nothing to act on, and no retry will conjure an address. Acknowledge and log loudly —
      // this one needs a human to close the access by hand.
      console.error('refund: no email on refunded charge', charge.id, '- revoke by hand');
      await alertOperator(
        'REFUND WITH NO EMAIL - close the access by hand\n\n' +
          `Charge: ${charge.id}\n` +
          'Stripe sent charge.refunded with no address on the charge, so nothing here can find ' +
          'the person. Their money is back and their course is still open. Open the charge in ' +
          'Stripe, take the email off the payment, then remove the Systeme enrollment and clear ' +
          'is_paid in Supabase.'
      );
      return received();
    }

    const revoked = await revokeCourseAccess(refundedEmail);
    if (!revoked) {
      await alertOperator(
        'REFUND SENT, COURSE STILL OPEN\n\n' +
          `Buyer: ${who(refundedEmail, charge.billing_details?.name)}\n` +
          `Charge: ${charge.id}\n` +
          'The money is back with the customer and removing their Systeme enrollment failed. ' +
          'Stripe will retry this event, so it may fix itself - but if no second alert says ' +
          'otherwise within the hour, remove the enrollment by hand.'
      );
      return new Response(JSON.stringify({ error: 'Revocation failed' }), {
        status: 500,
        headers: baseHeaders,
      });
    }

    await revokeAppAccess(refundedEmail);

    // The operations board, best effort: flip this buyer to Refunded/Revoked and add the
    // negative money row. Never affects the response - access is already closed above.
    try {
      await mondayRecordRefund({
        email: refundedEmail,
        chargeId: charge.id,
        amountRefundedCents: charge.amount_refunded ?? charge.amount,
        currency: charge.currency,
        livemode: event.livemode !== false,
      });
    } catch (err) {
      console.error('[monday] refund record failed (ignored):', err);
      await alertOperator(
        'BOOKKEEPING ONLY - refund not written to the board\n\n' +
          `Buyer: ${who(refundedEmail, charge.billing_details?.name)}\n` +
          `Charge: ${charge.id}\n` +
          'The customer is fine: their money is back and their access is closed. The monday row ' +
          'still says Paid and the money board has no negative row. Fix both in the next sweep.'
      );
    }

    return received();
  }

  // We only act on completed checkouts. Any other event type is acknowledged
  // (200) so Stripe stops sending it, but we do nothing with it.
  if (event.type !== 'checkout.session.completed') {
    return received();
  }

  const session = event.data?.object || {};

  // A comped seat - a course we are GIVING to someone (a tester walking the funnel, a guest).
  // create-checkout.js builds it behind COMP_ACCESS_KEY, discounts it to zero and stamps
  // `metadata.zf_comp`. That stamp is written by our own server on a session Stripe then
  // signs, so it cannot be forged from outside; and it is only honoured when the total really
  // is zero, so it can never wave a short payment through.
  //
  // The three guards below cannot apply to it: a zero-amount session has payment_status
  // `no_payment_required` and amount_total 0. Everything AFTER this point is identical to a
  // paid order on purpose - the whole point of a comp is to travel the real path.
  const isComp = session.metadata?.zf_comp === 'granted' && Number(session.amount_total) === 0;

  // Validate that this is a real, fully-paid order for OUR product. A
  // signature-valid event that fails these checks is acknowledged (200, no retry)
  // but NOT forwarded — we don't want to enroll, nor have Stripe retry.
  if (!isComp) {
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
  } else {
    console.log('[comp] zero-amount comped seat, session', session.id);
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

  // Mark the buyer inside the workshop room, if this address ever registered for a session.
  //
  // This is the buyer guard the whole sales sequence hangs off: every follow-up email carries
  // "and not a buyer", and wr-notify.js reads exactly this column immediately before each send.
  // Stripe stays the single source of purchase truth - the room never decides who bought, it
  // only records what Stripe already established.
  //
  // Best effort, and deliberately so. A failure here must not make this handler return 500,
  // because that would have Stripe retry a payment that was processed correctly (the enrollment
  // below is idempotent, but a retried event still re-runs the whole handler for nothing). The
  // worst case is one follow-up email reaching a customer, which wr-notify's send-time buyer
  // re-check still catches.
  await markWorkshopBuyer(email);

  // Open the course. This is the product — a failure here returns 500 so Stripe
  // retries the event until the enrollment lands; a paid order is never dropped.
  const systemeContactId = await enrollInCourse(email);
  if (!systemeContactId) {
    await alertOperator(
      'PAID, NO COURSE - enrollment failed\n\n' +
        `Buyer: ${who(email, session.customer_details?.name)}\n` +
        `Session: ${session.id}\n` +
        `Paid: ${session.amount_total} ${String(session.currency || '').toUpperCase()}\n` +
        'Stripe is retrying, so this can still land on its own. It gives up after about three ' +
        'days, and until then the buyer has paid and has nothing. If no "enrollment recovered" ' +
        'follows, open Systeme and enroll them by hand.'
    );
    return new Response(JSON.stringify({ error: 'Enrollment failed' }), {
      status: 500,
      headers: baseHeaders,
    });
  }

  // Best-effort app-user provisioning. Runs only after the enrollment succeeded. Never affects
  // the response: the course is already guaranteed; app access is a bonus that support can fix
  // if it fails. Awaited so it completes within the function lifetime, but fully wrapped.
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecret = process.env.SUPABASE_SECRET_KEY;
  let appProvisioned = false;
  if (supabaseUrl && supabaseSecret) {
    try {
      appProvisioned = (await provisionAppUser(email, session.id, supabaseUrl, supabaseSecret)) === true;
    } catch (err) {
      // Defensive: provisionAppUser shouldn't throw, but never let it break the 200 response.
      console.error('[provision] unexpected error (ignored):', err);
    }
  } else {
    console.warn('[provision] SUPABASE_URL or SUPABASE_SECRET_KEY not set — skipping app provisioning');
  }

  if (supabaseUrl && supabaseSecret && !appProvisioned) {
    // The course is already open at this point, so this is not a lost sale - it is a buyer who
    // will open the Toolkit and be told they are not a customer. Silent until 2026-08-19.
    await alertOperator(
      'PAID, NO TOOLKIT - app account not provisioned\n\n' +
        `Buyer: ${who(email, session.customer_details?.name)}\n` +
        `Session: ${session.id}\n` +
        'The course itself is open, this is only the app. They will hit the "customers only" ' +
        'screen at thezerofog.com/app. Create the Supabase user and set is_paid on their ' +
        'profile. The board row for this buyer says App account: Missing.'
    );
  }

  // The purchase-welcome email (E14). Runs only after the enrollment succeeded, same contract
  // as provisioning above: awaited, best-effort, never affects the response.
  const welcomed = await sendPurchaseWelcome(email);
  if (!welcomed) {
    await alertOperator(
      'PAID, NO WELCOME EMAIL - E14 was not sent\n\n' +
        `Buyer: ${who(email, session.customer_details?.name)}\n` +
        'Systeme still sends its own access email, so they are not left with nothing, but our ' +
        'welcome never went. Add them to the MailerLite group wr-E14 by hand - joining the ' +
        'group is what fires the automation.'
    );
  }

  // The operations board. Last of the best-effort steps, and the only one that records what
  // the earlier ones actually did: the buyer row carries whether the app account was really
  // provisioned, so a silent provisioning failure becomes visible instead of staying a log line.
  try {
    await mondayRecordPurchase({
      email,
      name: session.customer_details?.name || null,
      amountCents: session.amount_total,
      currency: session.currency,
      sessionId: session.id,
      chargeOrIntentId: session.payment_intent || null,
      customerId: typeof session.customer === 'string' ? session.customer : null,
      systemeContactId,
      appProvisioned,
      livemode: event.livemode !== false,
      comp: isComp,
    });
  } catch (err) {
    console.error('[monday] purchase record failed (ignored):', err);
    await alertOperator(
      'BOOKKEEPING ONLY - sale not written to the board\n\n' +
        `Buyer: ${who(email, session.customer_details?.name)}\n` +
        `Session: ${session.id}\n` +
        'The customer is fine: course open, app and welcome as reported above. They have no row ' +
        'on the customers board and no row on the money board. Add both in the next sweep.'
    );
  }

  // Meta Conversions API twin of the browser Purchase (see sendMetaPurchase). Comped seats are
  // excluded: a zero-euro internal grant must never teach the optimizer what a buyer looks like.
  // Awaited, best-effort, never affects the response.
  if (!isComp) await sendMetaPurchase(email, session);

  if (isComp) {
    await alertOperator(
      'COMPED SEAT - course given, no money taken\n\n' +
        `Person: ${who(email, session.customer_details?.name)}\n` +
        `Session: ${session.id}\n` +
        'Opened through the comp link, not a sale. Their row is on the board under ' +
        'Internal - not a customer, and there is no money row, because no euros moved. ' +
        'If this address was NOT one you handed a comp link to, revoke the link key now.'
    );
  }

  return received();
}

// Best-effort: create (or find) the Supabase auth user for this buyer and mark their profile paid.
// MUST NOT throw — provisioning failure must not affect the Stripe response or course enrollment.
async function provisionAppUser(email, sessionId, supabaseUrl, secretKey) {
  const adminHeaders = {
    'Content-Type': 'application/json',
    'apikey': secretKey,
    'Authorization': `Bearer ${secretKey}`,   // new key format: must equal apikey value
    'User-Agent': 'zerofog-stripe-webhook',    // avoid 401 browser-origin rejection
  };

  let userId = null;

  // 1) Try to create the user (email_confirm:true so they can log in via OTP without confirmation).
  try {
    const createRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ email, email_confirm: true }),
    });
    if (createRes.ok) {
      const created = await createRes.json();
      userId = created?.id || created?.user?.id || null;
    } else {
      // Likely already exists (e.g. repeat purchase or Stripe retry). Fall through to lookup.
      console.warn('[provision] createUser non-OK:', createRes.status);
    }
  } catch (err) {
    console.error('[provision] createUser error:', err);
  }

  // 2) If we don't have an id yet, look the user up by email (admin list with filter).
  if (!userId) {
    try {
      const listRes = await fetch(
        `${supabaseUrl}/auth/v1/admin/users?` + new URLSearchParams({ email }),
        { method: 'GET', headers: adminHeaders }
      );
      if (listRes.ok) {
        const data = await listRes.json();
        const users = data?.users || data?.aud || [];
        const match = Array.isArray(users)
          ? users.find(u => (u.email || '').toLowerCase() === email.toLowerCase())
          : null;
        userId = match?.id || null;
      } else {
        console.warn('[provision] listUsers non-OK:', listRes.status);
      }
    } catch (err) {
      console.error('[provision] listUsers error:', err);
    }
  }

  if (!userId) {
    console.error('[provision] could not resolve user id for', email, '- profile not written');
    return false;
  }

  // 3) Upsert the profile row marking the buyer paid (idempotent on user_id).
  try {
    const profRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?on_conflict=user_id`,
      {
        method: 'POST',
        headers: { ...adminHeaders, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          user_id: userId,
          email,
          is_paid: true,
          paid_at: new Date().toISOString(),
          payment_session_id: sessionId,
        }),
      }
    );
    if (!profRes.ok) {
      console.error('[provision] profile upsert non-OK:', profRes.status, await safeText(profRes));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[provision] profile upsert error:', err);
    return false;
  }
}

// small helper so logging a non-OK body can't throw
async function safeText(res){ try { return await res.text(); } catch { return ''; } }

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
