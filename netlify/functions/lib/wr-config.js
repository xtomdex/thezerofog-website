// Workshop Room - configuration.
//
// The shape below is the single description of how the room behaves. It ships as defaults in code
// so the system runs on a fresh database, and every field can be overridden by the single row in
// `wr_config` so the schedule, the timecodes and the copy can change without a deploy.
//
// Naming rule, CEO 2026-08-11: nothing customer-facing says "webinar" or "training". It is a
// workshop, and an occurrence of it is a session. That applies to this file's labels too.

import { selectOne } from './wr-db.js';

export const WEBINAR_KEY = 'zerofog-workshop';

export const DEFAULT_CONFIG = {
  key: WEBINAR_KEY,

  video: {
    // Placeholder until the master is uploaded to the CloudFront distribution that already serves
    // the course lessons. Kept as a plain URL so swapping hosts touches one line.
    url: null,
    youtubeFallbackId: 'LLUaY4viebE',
    posterUrl: null,
    // Measured off the master with ffprobe on 2026-08-13: `Full Web V2.mp4`, 3510.73 s,
    // 1920x1080 at 30fps, 448 MB. NOT estimated - the duration headers in this project have
    // lied before and once cost five agents a false finding.
    durationSec: 3511,
    // Captions ship as a WebVTT sidecar. The master carries them as an embedded mov_text track,
    // which an HTML5 <video> element does not render at all.
    captionsUrl: '/assets/captions/workshop-v2.vtt',
  },

  schedule: {
    registrationsOpen: true,
    closedRedirect: '/',
    timezoneMode: 'auto', // 'auto' = each visitor sees their own local time; 'fixed' = one zone
    fixedTimeZone: 'America/New_York',
    displaySlots: 6,
    maxDaysAhead: 2,
    minLeadMinutes: 5,
    jit: { enabled: true, intervalMin: 15 },
    onDemand: { enabled: false },
    // Four daily slots in US Eastern. The audience is US, 25-50, working from home.
    recurring: [
      {
        days: [0, 1, 2, 3, 4, 5, 6],
        times: ['10:00', '14:00', '19:00', '21:00'],
        timeZone: 'America/New_York',
      },
    ],
    // Registering twice replaces the earlier registration rather than creating a second one.
    duplicatePolicy: 'replace',
  },

  room: {
    allowSeek: false,
    joinGraceMinutes: 15, // how long after the start someone can still be let in
    stickyMessage: null,
    endRedirect: '/replay/',
    offer: {
      // The button appears when the product does, at 43:49, and stays for the rest of the
      // session. Not at the price (53:06) - by then they have watched nine minutes of pitch
      // with nothing to click.
      atSec: 2629,
      headline: 'Ready to reset all three systems?',
      buttonLabel: 'Get The Protocol',
      url: '/sales#enroll',
      sticky: true,
    },
    handouts: [],
    announcements: [],
    polls: [],
    // Manufactured liveness. Built, seeded empty, switched off. Turning any of these on is a
    // deliberate CEO decision, never a default that arrives with a deploy. See the spec, part 8.
    chat: { enabled: false, script: [] },
    attendeeCounter: { enabled: false },
    salePopups: { enabled: false },
  },

  replay: {
    enabled: true,
    mode: 'same_video', // 'same_video' | 'custom_video' | 'redirect'
    customVideoUrl: null,
    redirectUrl: null,
    expiresHours: 48,
    allowSeek: true, // a replay is openly a replay; nothing is preserved by forbidding it
    offerAtSec: 0,
    // The bonus link that only appears at the end. Its click is kept as a confirming signal, but
    // it is no longer the only evidence - we hold real watched seconds.
    bonusLinkUrl: '/app/?src=replay',
  },

  // Read off the master's own caption track on 2026-08-13, not estimated from the script.
  // AWAITING CEO CONFIRMATION BY EAR - the seconds are exact, the choice of sentence is a
  // judgement call and it decides which email a person gets.
  timecodes: {
    // 21:56 - "And what runs underneath is sleep." The mechanism is named here for the first
    // time; everything before it is pre-reveal language and must stay that way in email.
    revealSec: 1316,
    // 43:49 - "All right, let me show you what's inside. This is the Zero Fog."
    // Deliberately NOT the earlier "let me show you what I built" at 42:45: someone who left
    // between the two had not seen the product, and must still be sent the offer rather than
    // counted as having heard it. This is the same reasoning that moved the boundary from
    // slide 92 to slide 79 in the 2026-07-25 fact-check.
    offerSec: 2629,
    // Fraction of a threshold that counts as "reached it". Watched seconds, not position, so a
    // scrubber on the replay cannot buy the mechanism by dragging past it.
    watchedFraction: 0.9,
  },

  notifications: {
    // Nothing is delivered outside this window in the RECIPIENT's local time. A 9am slot would
    // otherwise put its six-hour reminder at 3am.
    deliveryWindow: { startHour: 7, endHour: 23 },
    sender: { from: 'hello@thezerofog.com', replyTo: 'kirill@thezerofog.com' },
    schedule: [
      { template: 'E1', anchor: 'register', offsetMin: 0, segments: ['all'] },
      { template: 'E2', anchor: 'start', offsetMin: -360, segments: ['all'] },
      { template: 'E3', anchor: 'start', offsetMin: -60, segments: ['all'] },
      { template: 'E4', anchor: 'start', offsetMin: -15, segments: ['all'] },
      { template: 'E5', anchor: 'start', offsetMin: 0, segments: ['all'] },

      { template: 'E9', anchor: 'end', offsetMin: 60, segments: ['SEG-A-noshow'] },
      { template: 'E10-B', anchor: 'end', offsetMin: 60, segments: ['SEG-B-pre-reveal'] },
      { template: 'E6', anchor: 'end', offsetMin: 30, segments: ['SEG-D-stayed'] },
      { template: 'E7', anchor: 'end', offsetMin: 120, segments: ['SEG-D-stayed'] },
      { template: 'E7-B', anchor: 'end', offsetMin: 120, segments: ['SEG-C-pre-offer'] },
      { template: 'E7-C', anchor: 'end', offsetMin: 960, segments: ['SEG-SAW-REVEAL'] },
      { template: 'E8', anchor: 'end', offsetMin: 1440, segments: ['SEG-SAW-REVEAL'] },
      { template: 'E8-B', anchor: 'end', offsetMin: 1440, segments: ['SEG-A-noshow', 'SEG-B-pre-reveal'] },
      { template: 'E11', anchor: 'end', offsetMin: 2880, segments: ['SEG-CLOSE'] },
      { template: 'E12', anchor: 'end', offsetMin: 4320, segments: ['SEG-CLOSE'] },
      { template: 'E13', anchor: 'end', offsetMin: 5760, segments: ['SEG-CLOSE'] },
      // CLOSE-24H is deliberately absent: it is fired by hand when the founding window closes.
    ],
  },

  webhooks: {
    // Event name -> Make endpoint. Falls back to MAKE_WEBHOOK_URL when a name is missing.
    routes: {},
    bearer: null,
  },

  privacy: {
    // Delete registrations and their attendance this many months after registration. Mirrors the
    // retention control EverWebinar exposes; ours actually runs on our own data.
    retainMonths: 24,
    consentText:
      'I agree to receive emails about this workshop and can unsubscribe at any time.',
    consentRequired: true,
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deep-merge an override over the defaults.
 *
 * Arrays REPLACE rather than concatenate. That is the behaviour you want for a schedule: setting
 * `times: ['19:00']` must mean one session a day, not five.
 */
export function mergeConfig(base, override) {
  if (!isPlainObject(override)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? mergeConfig(base[key], value) : value;
  }
  return out;
}

let cached = null;
let cachedAt = 0;
const CACHE_MS = 60 * 1000;

/**
 * The live config. Cached for a minute per warm function instance - the schedule page is the
 * busiest read in the system and it must not hit the database once per visitor.
 *
 * A database that is unreachable falls back to defaults rather than failing the request: a broken
 * config row must not be able to take the schedule page down.
 */
export async function loadConfig({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cachedAt < CACHE_MS) return cached;

  let row = null;
  try {
    row = await selectOne('wr_config', { key: `eq.${WEBINAR_KEY}`, select: 'data' });
  } catch (err) {
    console.error('wr-config: falling back to defaults:', err.message);
  }

  cached = mergeConfig(DEFAULT_CONFIG, row?.data);
  cachedAt = Date.now();
  return cached;
}

/** The segments a person belongs to, given what they actually watched. */
export function deriveSegments({ attended, watchedToRevealSec, watchedToOfferSec, replayEarned }) {
  const segments = [];

  if (!attended) segments.push('SEG-A-noshow');

  if (attended) {
    if (!watchedToRevealSec) segments.push('SEG-B-pre-reveal');
    // The subtraction. "Left before X" is a prefix predicate, so someone who walked out at minute
    // four satisfies BOTH thresholds. Without `AND NOT pre-reveal` they would receive the full
    // mechanism and the price - precisely what this segmentation exists to prevent.
    else if (!watchedToOfferSec) segments.push('SEG-C-pre-offer');
    else segments.push('SEG-D-stayed');
  }

  if (segments.includes('SEG-C-pre-offer') || segments.includes('SEG-D-stayed')) {
    segments.push('SEG-SAW-REVEAL');
  }

  if (replayEarned && (segments.includes('SEG-A-noshow') || segments.includes('SEG-B-pre-reveal'))) {
    segments.push('SEG-REPLAY-EARNED');
  }

  if (segments.includes('SEG-SAW-REVEAL') || segments.includes('SEG-REPLAY-EARNED')) {
    segments.push('SEG-CLOSE');
  }

  return segments;
}
