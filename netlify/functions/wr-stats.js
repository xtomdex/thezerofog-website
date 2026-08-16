// GET /.netlify/functions/wr-stats?key=<admin key>
//
// Every number EverWebinar's dashboard shows, computed from our own rows. Protected by a shared
// key in WORKSHOP_ADMIN_KEY - this returns registrant email addresses and watch behaviour, so it
// is never public.
//
// Computed in JavaScript rather than in SQL views on purpose: at our volume the whole dataset is
// a few thousand rows, and keeping the arithmetic next to the definitions means the segment
// boundaries stay readable and movable. The timecodes are still provisional.

import { json, preflight, safeEqual, select } from './lib/wr-db.js';
import { loadConfig } from './lib/wr-config.js';

const CURVE_BUCKET_SEC = 300; // five-minute resolution, matching what EverWebinar plots
const QUESTION_LIMIT = 200;

function pct(part, whole) {
  return whole ? Math.round((part / whole) * 1000) / 10 : 0;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const expected = process.env.WORKSHOP_ADMIN_KEY;
  const provided = new URL(req.url).searchParams.get('key') || '';
  if (!expected || !safeEqual(provided, expected)) {
    // Same answer for a missing key and a wrong one - no oracle.
    return json({ error: 'Not found' }, 404);
  }

  const config = await loadConfig().catch(() => null);
  if (!config) return json({ error: 'Server configuration error' }, 500);

  let rows;
  try {
    rows = await select('wr_registrations', {
      select:
        'id,email,created_at,purchased_at,time_zone,data,' +
        'wr_sessions(starts_at,kind),' +
        'wr_attendance(watched_sec,replay_watched_sec,max_position_sec,joined_at_position_sec,segments,first_seen_at)',
      order: 'created_at.desc',
      limit: 5000,
    });
  } catch (err) {
    console.error('wr-stats: read failed:', err.message);
    return json({ error: 'Server error' }, 500);
  }

  rows = rows || [];

  // The questions people actually typed in the room. The page promises "Kirill reads these
  // himself", and until 2026-08-16 nothing made that true: wr-question stored the row and
  // forwarded it to a Make webhook that was never configured in production, and no surface here
  // showed it. A question is worth more than any number below it, so it is read separately
  // rather than embedded in the registration query - one lost read must not cost the whole
  // dashboard, and vice versa.
  let questionRows = [];
  try {
    questionRows =
      (await select('wr_events', {
        select: 'id,created_at,position_sec,payload,wr_registrations(email,name)',
        type: 'eq.question',
        order: 'created_at.desc',
        limit: QUESTION_LIMIT,
      })) || [];
  } catch (err) {
    console.error('wr-stats: question read failed:', err.message);
  }

  const questions = questionRows.map((row) => {
    const reg = Array.isArray(row.wr_registrations) ? row.wr_registrations[0] : row.wr_registrations;
    return {
      id: row.id,
      askedAt: row.created_at,
      email: reg?.email || null,
      name: reg?.name || null,
      positionSec: row.position_sec,
      text: row.payload?.text || '',
    };
  });

  const duration = config.video.durationSec;
  const { revealSec, offerSec, thresholdGraceSec } = config.timecodes;

  const totals = {
    registrants: rows.length,
    liveAttendees: 0,
    replayAttendees: 0,
    buyers: 0,
    watchedToReveal: 0,
    watchedToOffer: 0,
    watchedAll: 0,
    liveWatchedSecSum: 0,
  };

  const segmentCounts = {};
  const bySource = {};
  const bySessionHour = {};
  // Buckets count how many people were still watching at each five-minute mark.
  const curve = new Array(Math.ceil(duration / CURVE_BUCKET_SEC)).fill(0);

  for (const row of rows) {
    const att = Array.isArray(row.wr_attendance) ? row.wr_attendance[0] : row.wr_attendance;
    const session = Array.isArray(row.wr_sessions) ? row.wr_sessions[0] : row.wr_sessions;

    const live = att?.watched_sec || 0;
    const replay = att?.replay_watched_sec || 0;

    if (live > 0) {
      totals.liveAttendees += 1;
      totals.liveWatchedSecSum += live;
      if (live >= revealSec - thresholdGraceSec) totals.watchedToReveal += 1;
      if (live >= offerSec - thresholdGraceSec) totals.watchedToOffer += 1;
      if (live >= duration - thresholdGraceSec) totals.watchedAll += 1;

      // The retention curve is drawn from WATCHED seconds, not from the furthest position
      // reached. Someone who joined at minute 40 was not present for minutes 0 to 39, and a
      // curve built from position would claim they were.
      const buckets = Math.min(Math.floor(live / CURVE_BUCKET_SEC), curve.length);
      for (let i = 0; i < buckets; i += 1) curve[i] += 1;
    }

    if (replay > 0) totals.replayAttendees += 1;
    if (row.purchased_at) totals.buyers += 1;

    for (const seg of att?.segments || []) {
      segmentCounts[seg] = (segmentCounts[seg] || 0) + 1;
    }

    // Which promise brought them, and did it bring people who stay.
    const utm = row.data?.utm || {};
    const key = utm.utm_content || utm.utm_campaign || utm.utm_source || 'direct';
    const source = (bySource[key] = bySource[key] || {
      registrants: 0,
      attended: 0,
      sawOffer: 0,
      buyers: 0,
    });
    source.registrants += 1;
    if (live > 0) source.attended += 1;
    if (live >= offerSec - thresholdGraceSec) source.sawOffer += 1;
    if (row.purchased_at) source.buyers += 1;

    // Which session times actually produce attendance - the question that decides the schedule.
    if (session?.starts_at) {
      const hour = new Intl.DateTimeFormat('en-GB', {
        timeZone: config.schedule.fixedTimeZone,
        hour: '2-digit',
        hour12: false,
      }).format(new Date(session.starts_at));
      const label = `${hour}:00 ${config.schedule.fixedTimeZone}`;
      const slot = (bySessionHour[label] = bySessionHour[label] || {
        kind: session.kind,
        registrants: 0,
        attended: 0,
        buyers: 0,
      });
      slot.registrants += 1;
      if (live > 0) slot.attended += 1;
      if (row.purchased_at) slot.buyers += 1;
    }
  }

  for (const key of Object.keys(bySource)) {
    bySource[key].showUpRate = pct(bySource[key].attended, bySource[key].registrants);
  }
  for (const key of Object.keys(bySessionHour)) {
    bySessionHour[key].showUpRate = pct(bySessionHour[key].attended, bySessionHour[key].registrants);
  }

  return json({
    ok: true,
    generatedAt: new Date().toISOString(),
    // Stated on the response so nobody reads these numbers without knowing the boundaries they
    // were computed against - the timecodes are provisional until the master is locked.
    timecodes: { revealSec, offerSec, thresholdGraceSec, durationSec: duration },
    totals: {
      ...totals,
      showUpRate: pct(totals.liveAttendees, totals.registrants),
      sawRevealRate: pct(totals.watchedToReveal, totals.liveAttendees),
      sawOfferRate: pct(totals.watchedToOffer, totals.liveAttendees),
      completionRate: pct(totals.watchedAll, totals.liveAttendees),
      averageWatchMinutes: totals.liveAttendees
        ? Math.round(totals.liveWatchedSecSum / totals.liveAttendees / 6) / 10
        : 0,
      conversionRate: pct(totals.buyers, totals.liveAttendees),
    },
    // Newest first, and deliberately near the top of what a reader scans.
    questions,
    segments: segmentCounts,
    retentionCurve: curve.map((count, i) => ({
      minute: (i * CURVE_BUCKET_SEC) / 60,
      stillWatching: count,
      share: pct(count, totals.liveAttendees),
    })),
    bySource,
    bySessionHour,
  });
}
