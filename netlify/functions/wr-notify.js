// Scheduled every five minutes. This is the piece EverWebinar was going to be bought for.
//
// The problem it solves, in our own words from the 2026-07-25 tech review: MailerLite delay steps
// cannot wait until a date held in a subscriber field, so with several daily sessions the wait to
// start differs per person and T-6h / T-1h / T-15min cannot be expressed there at all. The plan
// was to hand those five emails to EverWebinar's notification engine - which costs a second
// sending domain to warm up and a physical address hand-pasted into every template.
//
// Here the wait is a row with a timestamp. This function drains the ones that have come due,
// re-checks who the person turned out to be, and hands the send to Make, which owns MailerLite.
// We own timing and segmentation; delivery stays where it already works, footer and unsubscribe
// link included.

import { json, select, update } from './lib/wr-db.js';
import { loadConfig } from './lib/wr-config.js';

const BATCH = 200;

/** Does this queued email still apply to the person it was queued for? */
function stillApplies(entrySegments, personSegments) {
  if (!entrySegments || !entrySegments.length) return true;
  if (entrySegments.includes('all')) return true;
  return entrySegments.some((s) => personSegments.includes(s));
}

export default async function handler() {
  const now = new Date();

  let config;
  try {
    config = await loadConfig({ fresh: true });
  } catch (err) {
    console.error('wr-notify: config load failed:', err.message);
    return json({ error: 'config' }, 500);
  }

  let due;
  try {
    due = await select('wr_notifications', {
      select:
        'id,template,segments,scheduled_for,registration_id,' +
        'wr_registrations(email,name,token,time_zone,purchased_at,wr_sessions(starts_at),wr_attendance(segments,watched_sec,replay_watched_sec))',
      status: 'eq.pending',
      scheduled_for: `lte.${now.toISOString()}`,
      order: 'scheduled_for.asc',
      limit: BATCH,
    });
  } catch (err) {
    console.error('wr-notify: could not read the queue:', err.message);
    return json({ error: 'queue' }, 500);
  }

  if (!due || !due.length) return json({ ok: true, sent: 0, skipped: 0 });

  const target = config.webhooks?.routes?.notification || process.env.MAKE_WEBHOOK_URL;
  if (!target) {
    console.error('wr-notify: no delivery endpoint configured');
    return json({ error: 'no endpoint' }, 500);
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of due) {
    const reg = row.wr_registrations;

    // A registration deleted under us (retention sweep, erasure request) leaves its queue behind.
    if (!reg) {
      await update('wr_notifications', { id: `eq.${row.id}` }, { status: 'skipped' }).catch(() => {});
      skipped += 1;
      continue;
    }

    // The buyer guard. Every sales email in the sequence carries "AND NOT a buyer", and it has to
    // be checked at SEND time rather than at queue time - somebody who bought an hour after the
    // session was not a buyer when this row was written. Pitching a customer the thing they
    // already own is the single most expensive mistake this function could make.
    if (reg.purchased_at) {
      await update('wr_notifications', { id: `eq.${row.id}` }, { status: 'skipped' }).catch(() => {});
      skipped += 1;
      continue;
    }

    const attendance = Array.isArray(reg.wr_attendance) ? reg.wr_attendance[0] : reg.wr_attendance;
    const personSegments = attendance?.segments || [];

    if (!stillApplies(row.segments, personSegments)) {
      await update('wr_notifications', { id: `eq.${row.id}` }, { status: 'skipped' }).catch(() => {});
      skipped += 1;
      continue;
    }

    const session = Array.isArray(reg.wr_sessions) ? reg.wr_sessions[0] : reg.wr_sessions;

    const payload = {
      type: 'workshop_notification',
      template: row.template,
      email: reg.email,
      name: reg.name || undefined,
      // Merge fields the templates already expect.
      slot_time: session?.starts_at || null,
      time_zone: reg.time_zone || null,
      room_url: `${process.env.PUBLIC_SITE_URL || 'https://thezerofog.com'}/workshop/room/?t=${reg.token}`,
      segments: personSegments,
      from: config.notifications.sender.from,
      reply_to: config.notifications.sender.replyTo,
    };

    try {
      const res = await fetch(target, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.webhooks?.bearer ? { Authorization: `Bearer ${config.webhooks.bearer}` } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error(`delivery endpoint returned ${res.status}`);

      await update(
        'wr_notifications',
        { id: `eq.${row.id}` },
        { status: 'sent', sent_at: new Date().toISOString(), error: null }
      );
      sent += 1;
    } catch (err) {
      // Left as 'pending' on purpose so the next run picks it up again. Only the error text is
      // recorded - a five-minute cadence means a transient outage costs a late email, not a lost
      // one, and marking it failed here would throw the send away for good.
      console.error(`wr-notify: ${row.template} to ${reg.email} failed:`, err.message);
      await update('wr_notifications', { id: `eq.${row.id}` }, { error: String(err.message).slice(0, 300) }).catch(
        () => {}
      );
      failed += 1;
    }
  }

  console.log(`wr-notify: sent ${sent}, skipped ${skipped}, failed ${failed}`);
  return json({ ok: true, sent, skipped, failed });
}

// Netlify reads this to register the cron. Five minutes is the resolution of every reminder in
// the sequence: the tightest one is T-15min, so a five-minute grid can never turn it into T-0.
export const config = { schedule: '*/5 * * * *' };
