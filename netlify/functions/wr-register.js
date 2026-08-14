// POST /.netlify/functions/wr-register
//
// Registers someone for a session, mints their join token, forwards the lead to Make exactly as
// optin.js does today, and queues every email their journey can produce.
//
// Body: { email, name?, startsAt, tz, consent, website?, utm? }
// Returns: { ok, redirectUrl } - the same contract optin.js already returns, so the existing
// client code in index.js keeps working unchanged and keeps appending its UTM params.

import {
  insert,
  isValidEmail,
  json,
  mintToken,
  preflight,
  remove,
  select,
  selectOne,
  update,
  upsert,
} from './lib/wr-db.js';
import { loadConfig } from './lib/wr-config.js';
import {
  applyDeliveryWindow,
  describeSlot,
  isValidTimeZone,
  nextJitSlot,
  scheduledSlots,
  zonedDateParts,
} from './lib/wr-time.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

/**
 * Is this instant one we would actually have offered?
 *
 * The client sends a timestamp and the client can send anything. Without this check a scraper
 * could register for a session at 4am next March, and the reminder queue would faithfully serve
 * it. Recomputing the schedule server-side and requiring an exact match is the only trustworthy
 * validation - never validate a slot by parsing the string the browser handed you.
 */
function isBookableSlot(instant, now, schedule, blockedDates) {
  if (Number.isNaN(instant.getTime())) return false;
  if (instant.getTime() < now.getTime()) return false;

  if (schedule.jit.enabled) {
    // Any real JIT boundary still in the future qualifies (CEO 2026-08-14).
    //
    // `minLeadMinutes` used to be applied twice: once to decide which slot we OFFER, and again
    // here to decide what we ACCEPT. Those are different questions. The lead time exists so we
    // never put a slot in front of someone they cannot make - it has no business rejecting the
    // click that follows.
    //
    // What it cost, measured against this module rather than reasoned about: the schedule page
    // preselects the nearest JIT slot, and wr-slots will happily offer one that is 5 minutes and
    // ten seconds away. The old rule then recomputed `nextJitSlot(now)` at click time, which by
    // then had moved to the NEXT boundary, so delta went negative and the visitor got a 409 on
    // the option we had chosen for them. The window was "minutes shown minus five" - as little as
    // ten seconds to type an email and tick a box.
    //
    // Accepting up to the boundary itself is safe: that person arrives on time, and the room
    // grants a further `joinGraceMinutes` (5) after the start anyway.
    const step = schedule.jit.intervalMin * 60 * 1000;
    const hourStart = Math.floor(now.getTime() / (60 * 60 * 1000)) * 60 * 60 * 1000;
    const delta = instant.getTime() - hourStart;
    const withinWindow = instant.getTime() <= now.getTime() + schedule.maxDaysAhead * DAY_MS;
    if (delta >= 0 && delta % step === 0 && withinWindow) {
      if (!blockedDates.includes(zonedDateParts(instant, schedule.fixedTimeZone).iso)) return true;
    }
  }

  return scheduledSlots(now, {
    rules: schedule.recurring,
    daysAhead: schedule.maxDaysAhead,
    minLeadMinutes: schedule.minLeadMinutes,
    blockedDates,
  }).some((s) => s.getTime() === instant.getTime());
}

/** Find the session row for this instant, or create it. */
async function ensureSession(instant, kind) {
  const startsAt = instant.toISOString();

  const existing = await selectOne('wr_sessions', {
    select: 'id,starts_at,cap,registrant_count',
    starts_at: `eq.${startsAt}`,
  });
  if (existing) return existing;

  try {
    const created = await insert('wr_sessions', { starts_at: startsAt, kind });
    return Array.isArray(created) ? created[0] : created;
  } catch (err) {
    // Two people registering for the same brand-new slot in the same second both try to create
    // it. The unique index on starts_at makes the loser fail here; re-reading is the fix, not a
    // retry loop.
    const raced = await selectOne('wr_sessions', {
      select: 'id,starts_at,cap,registrant_count',
      starts_at: `eq.${startsAt}`,
    });
    if (raced) return raced;
    throw err;
  }
}

/**
 * Build the whole email queue for one registration.
 *
 * Everything is queued now, including the post-session emails whose audience is not yet known -
 * `wr-notify` re-checks the segment at send time. Queueing them up front is what makes the
 * segmentation auditable: you can look at the rows and see exactly what this person is going to
 * receive and when, instead of trusting a chain of automation steps inside an email platform.
 */
function buildQueue({ registrationId, sessionStart, durationSec, config, recipientZone, now }) {
  const sessionEnd = new Date(sessionStart.getTime() + durationSec * 1000);
  const window = config.notifications.deliveryWindow;

  return config.notifications.schedule.map((entry) => {
    let base;
    if (entry.anchor === 'register') base = now;
    else if (entry.anchor === 'start') base = sessionStart;
    else base = sessionEnd;

    const raw = new Date(base.getTime() + entry.offsetMin * 60 * 1000);

    // E1 is a receipt, not a reminder - holding it until morning would leave someone who just
    // signed up staring at an inbox with nothing in it.
    //
    // E5 (start, offset 0) is exempt for the same reason, decided by CEO 2026-08-14: it is the
    // door to a session the person chose themselves minutes ago. A JIT registrant at 02:00 gets
    // a 02:15 slot; the window would move "starting right now" to 07:00 - five hours after the
    // session - and that person's E2-E4 countdowns are all skipped, so E5 is the only email
    // that can carry the room link to them at start time.
    const exemptFromWindow =
      entry.anchor === 'register' || (entry.anchor === 'start' && entry.offsetMin === 0);
    const scheduledFor = exemptFromWindow ? raw : applyDeliveryWindow(raw, recipientZone, window);

    // The conditional reminders. Someone registering for a session in 20 minutes must not get a
    // six-hour reminder an instant later, and must never get one back-dated.
    const alreadyPast = scheduledFor.getTime() <= now.getTime();

    // ...nor one whose own promise the delivery window has broken.
    //
    // The window pushes anything landing at night into the next morning. For a follow-up that is
    // right. For a countdown it is not, because the countdown is in the text. Measured on a JIT
    // slot at 07:15 New York: the six-hour reminder computes to 01:15, the one-hour to 06:15,
    // both get moved to 07:00, and they arrive together with the fifteen-minute one - three
    // emails in the same minute, a quarter of an hour before the session, each still naming a
    // different lead time. Neither `alreadyPast` nor a check against the anchor sees it: every
    // one of those times is in the future and before the session starts.
    //
    // So the test is not whether it arrives in time, but whether it still tells the truth. Any
    // forward move breaks a countdown, and a reminder that cannot be sent when it says it will
    // be is better not sent - the later reminders in the sequence still cover that person.
    const windowBrokeThePromise =
      entry.offsetMin < 0 && scheduledFor.getTime() !== raw.getTime();

    return {
      registration_id: registrationId,
      template: entry.template,
      segments: entry.segments,
      scheduled_for: scheduledFor.toISOString(),
      status:
        entry.anchor !== 'register' && (alreadyPast || windowBrokeThePromise)
          ? 'skipped'
          : 'pending',
    };
  });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { email, name, startsAt, tz, consent, website, utm } = body;

  // Honeypot: bots fill it, humans never see it. Answer 200 so they believe they succeeded.
  if (website) return json({ ok: true, redirectUrl: '/confirmation/' });

  if (!isValidEmail(email)) {
    return json({ error: 'A valid email address is required.' }, 400);
  }

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error('wr-register: config load failed:', err.message);
    return json({ error: 'Server configuration error' }, 500);
  }

  if (!config.schedule.registrationsOpen) {
    return json({ error: 'Registration is closed.' }, 403);
  }

  if (config.privacy.consentRequired && consent !== true) {
    return json({ error: 'Consent is required to register.' }, 400);
  }

  const now = new Date();
  const cleanEmail = email.trim().toLowerCase();
  const recipientZone = isValidTimeZone(tz) ? tz : config.schedule.fixedTimeZone;

  let blockedDates = [];
  try {
    const rows = await select('wr_blocked_dates', { select: 'blocked_on' });
    blockedDates = (rows || []).map((r) => r.blocked_on);
  } catch (err) {
    console.error('wr-register: blocked dates unavailable:', err.message);
  }

  const instant = new Date(startsAt);
  if (!isBookableSlot(instant, now, config.schedule, blockedDates)) {
    // Almost always a stale page: the visitor left the schedule open past the slot they picked.
    return json({ error: 'That session is no longer available. Please pick another time.' }, 409);
  }

  try {
    const session = await ensureSession(instant, body.kind === 'jit' ? 'jit' : 'scheduled');

    if (session.cap && session.registrant_count >= session.cap) {
      return json({ error: 'That session is full. Please pick another time.' }, 409);
    }

    // Registering again replaces the earlier registration rather than creating a second one, and
    // the queued reminders of the old slot go with it. This is the case the old EverWebinar plan
    // flagged as unresolved - there, a queued reminder would keep firing against a stale slot
    // time because the wait lived inside the email platform. Here the reminders are rows, so
    // superseding them is a delete.
    const previous = await selectOne('wr_registrations', {
      select: 'id,token,session_id',
      email: `eq.${cleanEmail}`,
      webinar_key: `eq.${config.key}`,
      order: 'created_at.desc',
    });

    const token = previous?.token || mintToken();

    if (previous) {
      await update('wr_notifications', {
        registration_id: `eq.${previous.id}`,
        status: 'eq.pending',
      }, { status: 'superseded' });

      // The attendance of the session they are leaving must go with it.
      //
      // The registration row is REPLACED on (webinar_key, email), so `registration_id` survives a
      // re-registration - and wr_attendance hangs off that id and was never touched here. Two
      // things then leaked across sessions, both of them quietly:
      //
      //   watched_sec is written with Math.max, deliberately, so that reloading the page cannot
      //   walk the counter backwards. Across registrations that same guard carried the old
      //   session's total into the new one: someone who watched forty minutes and then no-showed
      //   their next slot still derived SEG-D-stayed and received the closing sequence for a
      //   session they were never in.
      //
      //   first_seen_at was only ever written when no row existed, so it stayed anchored to the
      //   FIRST session. The wall-clock clamp in wr-heartbeat measures a claim against the time
      //   elapsed since that stamp - with a stale one it allows anything, which switches off the
      //   anti-inflation guard for precisely the people who come back.
      //
      // Deleting rather than zeroing: a returning registrant should look exactly like a new one,
      // and every column here describes attendance at a session that is no longer theirs. Their
      // notification history is untouched and still carries the record of the sessions missed.
      //
      // Best effort. A stale attendance row is bad; refusing the registration over it is worse.
      try {
        await remove('wr_attendance', { registration_id: `eq.${previous.id}` });
      } catch (err) {
        console.error('wr-register: could not clear previous attendance:', err.message);
      }
    }

    const utmValues = {};
    for (const key of UTM_KEYS) {
      const value = utm?.[key];
      if (typeof value === 'string' && value) utmValues[key] = value.slice(0, 200);
    }

    const registrationRow = {
      webinar_key: config.key,
      session_id: session.id,
      email: cleanEmail,
      name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : null,
      token,
      time_zone: recipientZone,
      consent_at: consent === true ? now.toISOString() : null,
      consent_text: config.privacy.consentText,
      source: typeof body.source === 'string' ? body.source.slice(0, 60) : 'landing',
      // No IP is stored. It would buy us nothing here and it is personal data we would then have
      // to declare, justify and delete.
      data: { utm: utmValues },
    };

    const saved = await upsert('wr_registrations', registrationRow, 'webinar_key,email', {
      returning: true,
    });
    const registration = Array.isArray(saved) ? saved[0] : saved;
    const registrationId = registration?.id || previous?.id;

    await insert(
      'wr_notifications',
      buildQueue({
        registrationId,
        sessionStart: instant,
        durationSec: config.video.durationSec,
        config,
        recipientZone,
        now,
      }),
      { returning: false }
    );

    // The lead still goes to Make. Make owns MailerLite, tagging and anything Dima wires
    // downstream; this system owns timing and segmentation, not list management.
    //
    // "Unchanged" is what the previous comment claimed and it was not true: the opt-in form
    // sends `{email, name}`, this sends five more fields and - because the schedule step never
    // asks for a name - usually sends no `name` at all, since JSON.stringify drops undefined.
    // Three registrations in a row on 2026-08-13 preceded Make stopping the opt-in scenario.
    // The route is overridable so the two can be split without a deploy, but which module
    // actually failed is only visible in Make's own execution history.
    const makeUrl = config.webhooks?.routes?.registration || process.env.MAKE_WEBHOOK_URL;
    if (makeUrl) {
      try {
        const res = await fetch(makeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: cleanEmail,
            name: registrationRow.name || undefined,
            slot_time: instant.toISOString(),
            time_zone: recipientZone,
            token,
            ...utmValues,
          }),
        });
        if (!res.ok) console.error('wr-register: Make returned', res.status);
      } catch (err) {
        // A registration that reached our database is a real registration. Losing the Make
        // forward costs a tag; losing the registration costs the lead.
        console.error('wr-register: Make forward failed:', err.message);
      }
    }

    const described = describeSlot(instant, recipientZone, now);

    // Everything the confirmation page needs to greet them, show the time and build a calendar
    // entry. The address is deliberately NOT here - the page picks it up from sessionStorage,
    // because an email in a query string ends up in history, in referrers and in analytics.
    const params = new URLSearchParams({
      t: token,
      slot: instant.toISOString(),
      tz: recipientZone,
      when: described.label,
      dur: String(Math.round(config.video.durationSec / 60)),
    });
    if (registrationRow.name) params.set('name', registrationRow.name);

    return json({
      ok: true,
      redirectUrl: `/confirmation/?${params.toString()}`,
      token,
      startsAt: instant.toISOString(),
      when: described.label,
    });
  } catch (err) {
    console.error('wr-register failed:', err.message);
    return json({ error: 'Registration could not be completed.' }, 500);
  }
}
