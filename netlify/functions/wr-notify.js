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
import { loadConfig, deriveSegments } from './lib/wr-config.js';

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
        'wr_registrations(email,name,token,time_zone,purchased_at,no_sales,wr_sessions(starts_at),wr_attendance(segments,watched_sec,replay_watched_sec))',
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

  // Same reason as in wr-question.js, and here the stakes are higher: this function runs on a
  // five-minute cron. Pointed at the opt-in scenario's webhook it would post a payload that
  // scenario cannot read, over and over, until Make stopped it - and with it the whole funnel.
  // Without an endpoint the rows simply stay `pending` and go out when one is configured, so
  // refusing to send costs a delay and nothing else.
  const target = config.webhooks?.routes?.notification || process.env.MAKE_NOTIFICATION_WEBHOOK_URL;
  if (!target) {
    console.error('wr-notify: no delivery endpoint configured - set MAKE_NOTIFICATION_WEBHOOK_URL');
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

    // The no-sales guard. E13's P.P.S. promises "one click here and I stop - you'll still get
    // the useful stuff, just nothing about the price". The click sets no_sales on the
    // registration (wr-preferences.js), and this is where the promise is kept: templates
    // flagged `sales: true` in the schedule are skipped, everything else still goes.
    if (reg.no_sales) {
      const entry = config.notifications.schedule.find((e) => e.template === row.template);
      if (entry?.sales) {
        await update('wr_notifications', { id: `eq.${row.id}` }, { status: 'skipped' }).catch(() => {});
        skipped += 1;
        continue;
      }
    }

    const attendance = Array.isArray(reg.wr_attendance) ? reg.wr_attendance[0] : reg.wr_attendance;

    // A missing attendance row is not "no information about this person" - it IS the information.
    // Only wr-room.js and wr-heartbeat.js ever create one, and both require the room to have been
    // opened, so no row means they never arrived.
    //
    // Reading that as an empty segment list silently broke the entire no-show branch: E9 and E8-B
    // are addressed to SEG-A-noshow, `stillApplies` looks for an intersection, and an empty list
    // intersects nothing - so the emails written for people who did not come were skipped for
    // exactly the people who did not come. In a webinar funnel that is the largest group of all.
    //
    // Derived through deriveSegments rather than hard-coding the string, so this branch cannot
    // drift away from the segment logic the heartbeat uses.
    const personSegments =
      attendance?.segments?.length
        ? attendance.segments
        : deriveSegments({
            attended: false,
            watchedToRevealSec: false,
            watchedToOfferSec: false,
            replayEarned: false,
          });

    if (!stillApplies(row.segments, personSegments)) {
      await update('wr_notifications', { id: `eq.${row.id}` }, { status: 'skipped' }).catch(() => {});
      skipped += 1;
      continue;
    }

    const session = Array.isArray(reg.wr_sessions) ? reg.wr_sessions[0] : reg.wr_sessions;

    const roomUrl = `${process.env.PUBLIC_SITE_URL || 'https://thezerofog.com'}/workshop/room/?t=${reg.token}`;

    // The same Google Calendar entry the confirmation page builds, rebuilt server-side so E1's
    // add-to-calendar button has somewhere real to point (it used to lean on EverWebinar's link,
    // which is gone). Title and description mirror confirmation-2.js - one event, two doors.
    let calendarUrl = null;
    if (session?.starts_at) {
      const start = new Date(session.starts_at);
      const end = new Date(start.getTime() + Math.round(config.video.durationSec / 60) * 60000);
      const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      calendarUrl =
        'https://calendar.google.com/calendar/render?action=TEMPLATE' +
        '&text=' + encodeURIComponent('The Zero Fog Workshop') +
        '&dates=' + encodeURIComponent(stamp(start) + '/' + stamp(end)) +
        '&details=' + encodeURIComponent('Your personal link: ' + roomUrl + '\nA desktop or laptop works best.');
    }

    const payload = {
      type: 'workshop_notification',
      template: row.template,
      email: reg.email,
      name: reg.name || undefined,
      // Merge fields the templates already expect.
      slot_time: session?.starts_at || null,
      time_zone: reg.time_zone || null,
      room_url: roomUrl,
      calendar_url: calendarUrl,
      // The only door to the replay (see replay.js): /replay/?t= redirects into the room with
      // view=replay. Maps to [REPLAY_LINK] in E7-B / E8 / E8-B / E9 / E10-B.
      replay_url: `${process.env.PUBLIC_SITE_URL || 'https://thezerofog.com'}/replay/?t=${reg.token}`,
      // Maps to [STOP_FOUNDING_EMAILS] in E13: the one-click opt-out from the sales cadence.
      no_sales_url: `${process.env.PUBLIC_SITE_URL || 'https://thezerofog.com'}/no-thanks/?t=${reg.token}`,
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
