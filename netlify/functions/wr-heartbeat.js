// POST /.netlify/functions/wr-heartbeat
//
// Body: { t, positionSec, watchedSec, phase, event?, payload? }
//
// The player calls this every 20 seconds and once more on the way out via sendBeacon. It is the
// only source of attendance truth in the system, so two properties matter more than anything
// else here: it must be idempotent (a flaky connection fires it twice), and it must not believe
// the number the browser sends it.
//
// `watchedSec` is accumulated in the page from `timeupdate` deltas rather than read off
// `currentTime`. That distinction is the reason the replay gate works: reading currentTime would
// let someone drag the scrubber past the reveal and be credited with having watched it.

import { insert, json, preflight, selectOne, update, upsert } from './lib/wr-db.js';
import { loadConfig, deriveSegments } from './lib/wr-config.js';

const EVENT_TYPES = new Set([
  'heartbeat',
  // Opening the room and joining the session stopped being the same act when the session began
  // playing muted behind a blur before anyone clicks. Without this row the two are
  // indistinguishable, and "sat in front of the blur and left" would read as "attended".
  'join',
  'offer_shown',
  'offer_click',
  'handout_click',
  'poll_answer',
  'announcement_shown',
  'bonus_click',
  'exit',
  'pause',
  'resume',
]);

export default async function handler(req) {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { t: token, positionSec, watchedSec, phase, event, payload } = body;
  if (!token || typeof token !== 'string') return json({ error: 'Invalid link.' }, 400);

  const config = await loadConfig().catch(() => null);
  if (!config) return json({ error: 'Server configuration error' }, 500);

  let registration;
  try {
    registration = await selectOne('wr_registrations', {
      select: 'id,session_id,wr_sessions(starts_at),wr_attendance(first_seen_at,watched_sec,max_position_sec,replay_watched_sec)',
      token: `eq.${token}`,
    });
  } catch (err) {
    console.error('wr-heartbeat: lookup failed:', err.message);
    return json({ error: 'Server error' }, 500);
  }
  if (!registration) return json({ error: 'This link is not valid.' }, 404);

  const now = Date.now();
  const isReplay = phase === 'replay';
  const attendance = Array.isArray(registration.wr_attendance)
    ? registration.wr_attendance[0]
    : registration.wr_attendance;

  const duration = config.video.durationSec;
  const position = Number.isFinite(positionSec) ? Math.max(0, Math.min(positionSec, duration)) : 0;

  // Clamp the claim against wall-clock time.
  //
  // Nothing stops a browser from posting "I watched all 5400 seconds" one second after joining,
  // and the mechanism-bearing emails hang off exactly this number. So the accepted figure can
  // never exceed the time that has actually elapsed since this person first appeared, plus a
  // small allowance for the heartbeat interval itself.
  const firstSeen = attendance?.first_seen_at ? new Date(attendance.first_seen_at).getTime() : now;
  const elapsedSec = Math.max(0, Math.round((now - firstSeen) / 1000)) + 60;
  const claimed = Number.isFinite(watchedSec) ? Math.max(0, watchedSec) : 0;
  const acceptedWatched = Math.min(claimed, elapsedSec, duration);

  const previousWatched = (isReplay ? attendance?.replay_watched_sec : attendance?.watched_sec) || 0;
  const previousPosition = attendance?.max_position_sec || 0;

  const row = {
    registration_id: registration.id,
    last_seen_at: new Date(now).toISOString(),
    // Monotonic on purpose: a reload restarts the page's own counters at zero, and the stored
    // total must not fall back with them.
    max_position_sec: Math.max(previousPosition, position),
  };
  if (isReplay) row.replay_watched_sec = Math.max(previousWatched, acceptedWatched);
  else row.watched_sec = Math.max(previousWatched, acceptedWatched);
  if (!attendance) row.first_seen_at = new Date(now).toISOString();

  try {
    await upsert('wr_attendance', row, 'registration_id');
  } catch (err) {
    console.error('wr-heartbeat: attendance write failed:', err.message);
    return json({ error: 'Server error' }, 500);
  }

  // Named events are worth a row of their own; plain heartbeats are not - at one every twenty
  // seconds they would be the largest table in the database inside a month, and the attendance
  // row already holds everything a heartbeat would have told us.
  if (event && EVENT_TYPES.has(event) && event !== 'heartbeat') {
    try {
      await insert(
        'wr_events',
        {
          registration_id: registration.id,
          type: event,
          position_sec: position,
          payload: payload && typeof payload === 'object' ? payload : null,
        },
        { returning: false }
      );
    } catch (err) {
      console.error('wr-heartbeat: event write failed:', err.message);
    }
  }

  // Recompute the segments this person now belongs to.
  //
  // The thresholds are measured in WATCHED seconds, not in where the playhead reached. This is
  // the fix for the leak the old EverWebinar plan logged and never resolved: someone who joins at
  // minute 40 and leaves at minute 50 exits after the reveal timecode but has watched none of it,
  // and under an exit-minute rule would receive the mechanism by email. Here they cannot.
  const { revealSec, offerSec, watchedFraction } = config.timecodes;

  // Live and replay are counted in separate columns and never pooled. They answer different
  // questions: "did they see the reveal in the session" decides the post-session branch, while
  // "did they earn the replay" decides whether a no-show may be sent the mechanism later.
  const liveWatched = isReplay ? attendance?.watched_sec || 0 : row.watched_sec;
  const replayWatched = isReplay ? row.replay_watched_sec : attendance?.replay_watched_sec || 0;
  const totalWatched = liveWatched + replayWatched;

  const segments = deriveSegments({
    attended: liveWatched > 0,
    watchedToRevealSec: liveWatched >= revealSec * watchedFraction,
    watchedToOfferSec: liveWatched >= offerSec * watchedFraction,
    replayEarned: replayWatched >= revealSec * watchedFraction || event === 'bonus_click',
  });

  try {
    await update(
      'wr_attendance',
      { registration_id: `eq.${registration.id}` },
      { segments, total_watched_sec: totalWatched }
    );
  } catch (err) {
    console.error('wr-heartbeat: segment write failed:', err.message);
  }

  // The player does not need an answer, and waiting for one on a beacon is pointless.
  return json({ ok: true }, 200);
}
