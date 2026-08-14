// MailerLite delivery for the workshop notification queue.
//
// Make is out of the email path as of 2026-08-14, on counted numbers: the Free plan allows two
// active scenarios (both slots are taken by Opt-In and Payment Processing) and 1000 operations a
// month - about 25 registrants' worth of funnel. And the opt-in scenario never sent mail anyway;
// sending always lived in MailerLite. So wr-notify talks to MailerLite directly.
//
// The mechanism: one MailerLite group per template (`wr-E1` ... `wr-E13`), and an automation in
// MailerLite per group - trigger "joins the group", one email, allow re-entry. This module's job
// per due row is exactly three calls:
//
//   1. upsert the subscriber with the merge fields the template needs
//   2. remove them from the template's group (a join can only fire for someone not in the group)
//   3. add them to the group - that join IS the send
//
// Unsubscribes, bounces and the legal footer stay MailerLite-native, which is the reason this
// path was chosen over a transactional provider: the domain is already authenticated there
// (SPF `_spf.mlsend.com` + DKIM `litesrv._domainkey` were verified in DNS on 2026-08-14).
//
// MAILERLITE_API_BASE exists for the selftest: pointed at an unreachable host, a send fails and
// the row stays `pending` - the same contract the Make webhook had.

const BASE = () => process.env.MAILERLITE_API_BASE || 'https://connect.mailerlite.com/api';

async function api(path, method = 'GET', body = null) {
  const res = await fetch(BASE() + path, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.MAILERLITE_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`MailerLite ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  }
  // 204 No Content is a normal answer for group removal.
  return res.status === 204 ? null : res.json();
}

// Group ids never change once created, so one lookup per warm instance is enough. A template
// whose group is missing is a configuration error and must fail the send loudly - a silent
// skip here would read as "delivered" in the stats.
let groupsByName = null;

async function groupId(template) {
  if (!groupsByName) {
    const out = {};
    const list = await api('/groups?limit=100');
    for (const g of list.data || []) out[g.name] = g.id;
    groupsByName = out;
  }
  const id = groupsByName[`wr-${template}`];
  if (!id) throw new Error(`no MailerLite group named wr-${template}`);
  return id;
}

/** Reset the group cache - for tests only. */
export function resetGroupCache() {
  groupsByName = null;
}

/**
 * Deliver one queued notification. Throws on any failure so wr-notify records the error and
 * leaves the row pending for the next cron run.
 */
export async function deliverNotification(payload) {
  const gid = await groupId(payload.template);

  const up = await api('/subscribers', 'POST', {
    email: payload.email,
    fields: {
      name: payload.name || null,
      slot_time: payload.slot_time_label || payload.slot_time || null,
      room_url: payload.room_url || null,
      calendar_url: payload.calendar_url || null,
      replay_url: payload.replay_url || null,
      no_sales_url: payload.no_sales_url || null,
    },
  });
  const subscriberId = up?.data?.id;
  if (!subscriberId) throw new Error('MailerLite upsert returned no subscriber id');

  // Leaving first makes the following join fire even for someone who got this template before
  // (a re-registration queues the same template again). Removal of a non-member answers 204
  // too, so there is nothing to special-case.
  await api(`/subscribers/${subscriberId}/groups/${gid}`, 'DELETE').catch(() => {});
  await api(`/subscribers/${subscriberId}/groups/${gid}`, 'POST');

  return { subscriberId, groupId: gid };
}
