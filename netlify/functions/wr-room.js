// GET /.netlify/functions/wr-room?t=<token>
//
// The room's brain. The page renders nothing on its own: it asks this function what state the
// session is in, where the playhead should be, and which timed elements exist. Every decision is
// made here, on the server, because a page that computes its own position is a page anyone can
// tell to be at minute 43.
//
// This is also the only route by which the video URL reaches a browser, which is what makes the
// token worth having.

import { insert, json, preflight, selectOne, update } from './lib/wr-db.js';
import { loadConfig } from './lib/wr-config.js';

const MINUTE = 60 * 1000;

function publicTimedElements(config, phase) {
  const { room, replay } = config;

  const offerAt = phase === 'replay' ? replay.offerAtSec : room.offer.atSec;

  return {
    offer: { ...room.offer, atSec: offerAt },
    handouts: room.handouts,
    announcements: room.announcements,
    polls: room.polls,
    stickyMessage: room.stickyMessage,
    // Manufactured liveness stays server-gated. If the switch is off the browser never receives
    // the script, so there is nothing to turn on from the console.
    chat: room.chat.enabled ? room.chat : { enabled: false, script: [] },
    attendeeCounter: room.attendeeCounter.enabled ? room.attendeeCounter : { enabled: false },
  };
}

function videoSource(config, phase) {
  if (phase === 'replay' && config.replay.mode === 'custom_video' && config.replay.customVideoUrl) {
    return config.replay.customVideoUrl;
  }
  return config.video.url;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const url = new URL(req.url);
  const token = url.searchParams.get('t');
  if (!token || token.length < 16) return json({ error: 'Invalid link.' }, 400);

  // Which door the visitor came through. Only /replay/ sets this, and it only matters after the
  // session has ended - see the `ended` branch below. It gates nothing secret: the same token
  // would open the replay from that page anyway. It exists so the room cannot silently become
  // the replay on its own.
  const view = url.searchParams.get('view');

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error('wr-room: config load failed:', err.message);
    return json({ error: 'Server configuration error' }, 500);
  }

  let registration;
  try {
    registration = await selectOne('wr_registrations', {
      select: 'id,email,name,time_zone,session_id,wr_sessions(starts_at,kind),wr_attendance(max_position_sec)',
      token: `eq.${token}`,
    });
  } catch (err) {
    console.error('wr-room: lookup failed:', err.message);
    return json({ error: 'Server error' }, 500);
  }

  if (!registration) return json({ error: 'This link is not valid.' }, 404);

  const session = registration.wr_sessions;
  if (!session) return json({ error: 'Session not found.' }, 404);

  const now = Date.now();
  const start = new Date(session.starts_at).getTime();
  const durationSec = config.video.durationSec;
  const end = start + durationSec * 1000;
  const replayEnd = end + config.replay.expiresHours * 60 * MINUTE;

  const base = {
    ok: true,
    name: registration.name,
    startsAt: session.starts_at,
    durationSec,
    serverNow: new Date(now).toISOString(),
  };

  // Before it begins: a countdown, and deliberately no video URL. Handing over the file early
  // would let anyone with a link watch whenever they liked, which is the whole thing we are
  // building a session model to avoid.
  if (now < start) {
    return json({
      ...base,
      state: 'early',
      secondsUntilStart: Math.round((start - now) / 1000),
    });
  }

  if (now < end) {
    const positionSec = Math.floor((now - start) / 1000);
    const lateBySec = Math.max(0, positionSec);

    // Record the join.
    //
    // `first_seen_at` and `joined_at_position_sec` are written ONCE and never touched again.
    // Upserting them on every request looked harmless and was not: reloading the room reset
    // `first_seen_at` to the current moment, and the heartbeat clamps claimed watch time against
    // the time elapsed since that column. A viewer who refreshed at minute 80 would stop
    // accruing watched seconds entirely - and their segment would freeze wherever it stood.
    // It also erased the record of whether they joined late.
    try {
      const existing = await selectOne('wr_attendance', {
        select: 'registration_id',
        registration_id: `eq.${registration.id}`,
      });

      if (existing) {
        await update(
          'wr_attendance',
          { registration_id: `eq.${registration.id}` },
          { last_seen_at: new Date(now).toISOString() }
        );
      } else {
        await insert(
          'wr_attendance',
          {
            registration_id: registration.id,
            first_seen_at: new Date(now).toISOString(),
            last_seen_at: new Date(now).toISOString(),
            joined_at_position_sec: lateBySec,
          },
          { returning: false }
        );
        await insert(
          'wr_events',
          { registration_id: registration.id, type: 'join', position_sec: positionSec },
          { returning: false }
        );
      }
    } catch (err) {
      // Never fail the room over bookkeeping. A session that will not play because an insert
      // failed is a far worse outcome than a missing analytics row.
      console.error('wr-room: could not record join:', err.message);
    }

    return json({
      ...base,
      state: 'live',
      positionSec,
      allowSeek: config.room.allowSeek,
      lateJoin: positionSec > config.room.joinGraceMinutes * 60,
      videoUrl: videoSource(config, 'live'),
      posterUrl: config.video.posterUrl,
      captionsUrl: config.video.captionsUrl,
      elements: publicTimedElements(config, 'live'),
      endRedirect: config.room.endRedirect,
    });
  }

  if (!config.replay.enabled || now >= replayEnd) {
    return json({
      ...base,
      state: 'expired',
      // The offer still exists after the replay does; the sales page is not gated on any of this.
      offerUrl: config.room.offer.url,
    });
  }

  if (config.replay.mode === 'redirect' && config.replay.redirectUrl) {
    return json({ ...base, state: 'replay-redirect', redirectUrl: config.replay.redirectUrl });
  }

  // The replay is a separate destination, not what the room turns into (CEO 2026-08-14).
  //
  // It used to be both: the second the session ended, the same room handed the same person the
  // same video with a scrub bar. The one who sat through to the offer - the hottest person in the
  // funnel, looking at the price - was told, in effect, that nothing had to be decided today.
  // And it contradicted our own email: E9 and E10-B go out an hour later promising the replay to
  // people who did NOT come or left early. It was never meant for the person who stayed.
  //
  // So the room now ends. The replay lives at /replay/?t=, which is what the email links to, and
  // reaching it takes that deliberate step - `view=replay` is set by that page and by nothing
  // else. Same player, same token, same 48-hour deadline; only the way in is different.
  if (view !== 'replay') {
    return json({
      ...base,
      state: 'ended',
      offerUrl: config.room.offer.url,
      offerHeadline: config.room.offer.headline,
      offerButtonLabel: config.room.offer.buttonLabel,
    });
  }

  // Where the replay should open. "You can pick up where you stepped out" is a promise the
  // E10-B email makes (CEO 2026-08-14) - so the replay starts at the furthest point this person
  // actually reached, not at zero. Monotonic max_position_sec covers both live and earlier
  // replay visits. Two guards: someone who barely started gets a clean start from the top, and
  // someone who reached the end is not dropped onto the closing frame.
  const attendance = Array.isArray(registration.wr_attendance)
    ? registration.wr_attendance[0]
    : registration.wr_attendance;
  const reached = attendance?.max_position_sec || 0;
  const resumeAtSec = reached > 120 && reached < durationSec - 120 ? reached : 0;

  return json({
    ...base,
    state: 'replay',
    // A real deadline, computed from this person's own session. The page it replaces ran a
    // 48-hour countdown in localStorage that said "expired" and then served the video and the
    // $67 button anyway, and restarted itself on the next visit.
    expiresAt: new Date(replayEnd).toISOString(),
    secondsUntilExpiry: Math.round((replayEnd - now) / 1000),
    resumeAtSec,
    allowSeek: config.replay.allowSeek,
    videoUrl: videoSource(config, 'replay'),
    posterUrl: config.video.posterUrl,
    elements: publicTimedElements(config, 'replay'),
    bonusLinkUrl: config.replay.bonusLinkUrl,
  });
}
