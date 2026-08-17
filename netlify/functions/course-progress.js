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

const ALLOWED_ORIGIN = 'https://platform.thezerofog.com';

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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

  let body = {};
  try { body = await req.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400); }

  // Everything below is attacker-controlled. Nothing is stored that is not one of these.
  const studentId = body.studentId;
  const completed = body.completed;
  const total = body.total;
  const course = typeof body.course === 'string' ? body.course.slice(0, 64) : null;
  const name = typeof body.name === 'string' ? body.name.slice(0, 120) : null;

  if (!isInt(studentId, 1, 1e12)) return json({ error: 'Bad studentId' }, 400);
  if (!isInt(completed, 0, 1000)) return json({ error: 'Bad completed' }, 400);
  if (!isInt(total, 0, 1000)) return json({ error: 'Bad total' }, 400);
  if (completed > total) return json({ error: 'Bad counts' }, 400);

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/service_events`, {
      method: 'POST',
      headers: {
        'apikey': secretKey,
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        source: 'course',
        event: 'course_progress',
        ref: course,
        data: { systeme_user_id: studentId, completed, total, name },
      }),
    });
    if (!res.ok) {
      console.error('[course-progress] insert non-OK:', res.status, await res.text());
    }
  } catch (err) {
    console.error('[course-progress] insert threw:', err && err.message);
  }

  return json({ ok: true });
}
