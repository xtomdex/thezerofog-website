// Receives lesson progress read out of the Systeme student area and files it in
// public.service_events. Added 2026-08-17.
//
// WHY THIS EXISTS
//
// Systeme's PUBLIC API exposes no progress at all - probed 2026-08-17, every plausible
// endpoint 404s and the enrolment object carries only id/contact/course/accessType/active.
// Its own student app, however, reads two private endpoints on the session cookie:
//   GET /api/user/user-data                  -> the logged-in student (id, name, timezone)
//   GET /api/membership/course/{id}/menu     -> every lecture with a `completed` flag
// Our script is already embedded on every course page, so it can read both and post the
// result here. We do not build lesson logging; we relay theirs.
//
// UNAUTHENTICATED ON PURPOSE, AND WHAT THAT COSTS
//
// The course runs on platform.thezerofog.com under Systeme's session, where we hold no
// token of our own to verify. So this endpoint trusts the browser. That is acceptable
// because the threat model is inverted: the only available lie is "I studied MORE", which
// argues against the sender's own refund claim. Nobody forges proof that they consumed
// the thing they want refunded.
//
// It does mean anyone can post junk, so the shape is validated hard and the payload is
// capped. Volume is bounded on the client: it posts once per browser session and again
// only when the completed count actually changes.
//
// NO EMAIL YET. Course rows carry the Systeme user id in `data` and leave `email` null,
// because on the only account we could inspect the student and the site owner are the
// same person, so we cannot tell whether Systeme's address field is the student's or the
// school account's. Setting it wrongly would stamp every student with our own address.
// One real test student settles it; until then `id` is the key.

import { notifyOperator } from './lib/wr-telegram.js';

const ALLOWED_ORIGIN = 'https://platform.thezerofog.com';

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Two shapes arrive here:
//   {kind:'watch', studentId, lectureId, watched, duration, course, name} -> lesson_watch
//   {studentId, completed, total, course, name}                          -> course_progress

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const isInt = (v, min, max) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const supabaseUrl = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !secretKey) {
    console.error('[course-progress] SUPABASE_URL or SUPABASE_SECRET_KEY not set');
    return json({ ok: false });
  }

  // Body may arrive as text/plain: the watch report is sent with navigator.sendBeacon at
  // page-hide, and only a simple content type avoids a CORS preflight the browser has no
  // time left to complete. req.json() parses either way.
  let body = {};
  try { body = await req.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400); }

  // Everything below is attacker-controlled. Nothing is stored that is not one of these.
  const studentId = body.studentId;
  const course = typeof body.course === 'string' ? body.course.slice(0, 64) : null;
  const name = typeof body.name === 'string' ? body.name.slice(0, 120) : null;
  if (!isInt(studentId, 1, 1e12)) return json({ error: 'Bad studentId' }, 400);

  let row = null;

  if (body.kind === 'watch') {
    // How much of a lesson video was actually played. This is the strongest delivery
    // evidence we can produce: not "the page was open", but "these minutes were watched".
    // Systeme has its own per-lecture session logging, but it is plan-gated - their player
    // code flips lectureSessionLogging to false on a "locked" response - so we measure it
    // ourselves off the <video> element.
    const lectureId = body.lectureId;
    const watched = Math.round(Number(body.watched));
    const duration = Math.round(Number(body.duration));
    if (!isInt(lectureId, 1, 1e12)) return json({ error: 'Bad lectureId' }, 400);
    if (!isInt(watched, 1, 86400)) return json({ error: 'Bad watched' }, 400);
    if (!isInt(duration, 0, 86400)) return json({ error: 'Bad duration' }, 400);
    row = {
      source: 'course',
      event: 'lesson_watch',
      ref: String(lectureId),
      data: {
        systeme_user_id: studentId,
        watched_sec: watched,
        duration_sec: duration || null,
        course,
        name,
      },
    };
  } else {
    const completed = body.completed;
    const total = body.total;
    if (!isInt(completed, 0, 1000)) return json({ error: 'Bad completed' }, 400);
    if (!isInt(total, 0, 1000)) return json({ error: 'Bad total' }, 400);
    if (completed > total) return json({ error: 'Bad counts' }, 400);
    row = {
      source: 'course',
      event: 'course_progress',
      ref: course,
      data: { systeme_user_id: studentId, completed, total, name },
    };
  }

  // Has this student ever been seen before? Asked BEFORE the insert, because after it the
  // answer is always yes. Only used to decide whether to alert - never to decide what to store.
  let firstEver = false;
  if (row.event === 'course_progress') {
    firstEver = await neverSeenBefore(supabaseUrl, secretKey, studentId);
  }

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/service_events`, {
      method: 'POST',
      headers: {
        'apikey': secretKey,
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      console.error('[course-progress] insert non-OK:', res.status, await res.text());
    }
  } catch (err) {
    console.error('[course-progress] insert threw:', err && err.message);
  }

  // The moment the CEO wants on his phone: a buyer just walked into the course, so a hello in
  // the chat lands while they are still inside instead of sitting unread.
  //
  // Identified by NAME, not by address. The Systeme id in these rows maps to nothing we hold -
  // their public API exposes no progress and their contact id is a different number entirely
  // (checked on the first real buyer: contact 440760643, student 15118959). A name is enough to
  // recognise a buyer in an alert; it would not be enough to automate anything, and nothing here
  // does.
  if (firstEver) {
    await notifyOperator(
      'COURSE OPENED\n\n' +
        `${name || '(no name)'}\n` +
        `${body.completed} of ${body.total} lessons done\n` +
        (course ? `${course}\n` : '') +
        '\nThey are in the course area right now. Crisp reaches them here.'
    );
  }

  return json({ ok: true });
}

/**
 * True when this Systeme student has no course_progress row yet - i.e. this is the first time
 * we have ever seen them open the course.
 *
 * Best effort, and it fails CLOSED: a Supabase hiccup returns false, so a wobble costs one
 * missed alert rather than a repeated one on every page they open.
 */
async function neverSeenBefore(supabaseUrl, secretKey, studentId) {
  try {
    const endpoint = new URL(`${supabaseUrl}/rest/v1/service_events`);
    endpoint.searchParams.set('event', 'eq.course_progress');
    endpoint.searchParams.set('data->>systeme_user_id', `eq.${studentId}`);
    endpoint.searchParams.set('select', 'id');
    endpoint.searchParams.set('limit', '1');

    const res = await fetch(endpoint, {
      headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}` },
    });
    if (!res.ok) return false;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length === 0;
  } catch (err) {
    console.error('[course-progress] first-seen check threw:', err && err.message);
    return false;
  }
}
