// Workshop room - live smoke test.
//
//   node scripts/wr-selftest.mjs
//
// WRITES TO THE REAL DATABASE and deletes what it wrote. It registers one address of the form
// wr-selftest-<timestamp>@thezerofog.com, drives it through a whole session, and removes the
// registration and its session at the end - the cascade takes attendance, events and the queue
// with it. Run it after any change to the wr-* functions; it has already caught two defects that
// reading the code did not.
//
// Reads credentials from .env, which is gitignored. No email is ever sent: the notification
// endpoint is pointed at an unreachable host for that step.
//
// One thing to know before running it against production: the notify step drains the WHOLE
// queue, not only the rows this test made, so every other due notification is attempted against
// that unreachable host and comes back a failure. Nothing is lost - a failed send stays
// `pending` and only records the error text, so the next cron run picks it up again - but the
// error column on other people's rows will carry this test's fingerprints.

import fs from 'node:fs';
for (const line of fs.readFileSync('/Users/Cyrill/AI SANDBOX/thezerofog-website/.env','utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && m[2]) process.env[m[1]] = m[2].trim();
}

const B = '/Users/Cyrill/AI SANDBOX/thezerofog-website/netlify/functions/';
const URL_BASE = 'https://thezerofog.com/.netlify/functions/';
const db = await import(B + 'lib/wr-db.js');

let fail = 0, notes = [];
const eq = (n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);
  if(!ok){fail++;console.log(`FAIL ${n}\n  got  ${JSON.stringify(g)}\n  want ${JSON.stringify(w)}`)}
  else console.log(`ok   ${n} -> ${JSON.stringify(g)}`)};

const EMAIL = `wr-selftest-${Date.now()}@thezerofog.com`;
let regId = null, sessionId = null, token = null;

try {
  // --- 1. slots, against the real database ---
  const { default: slots } = await import(B + 'wr-slots.js');
  const sr = await slots(new Request(URL_BASE + 'wr-slots?tz=America/New_York'));
  const sb = await sr.json();
  eq('slots: 200', sr.status, 200);
  eq('slots: offers sessions', sb.slots.length > 0, true);
  const chosen = sb.slots[0];
  console.log(`     picked: ${chosen.kind} ${chosen.label} (in ${chosen.minutesAway} min)`);

  // --- 2. register ---
  const { default: register } = await import(B + 'wr-register.js');
  const rr = await register(new Request(URL_BASE + 'wr-register', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ email: EMAIL, name:'Selftest', startsAt: chosen.startsAt,
      kind: chosen.kind, tz:'America/New_York', consent:true,
      utm:{utm_source:'selftest', utm_content:'a1'} })
  }));
  const rb = await rr.json();
  eq('register: 200', rr.status, 200);
  eq('register: returns a token', typeof rb.token === 'string' && rb.token.length >= 22, true);
  eq('register: redirects to confirmation', rb.redirectUrl.startsWith('/confirmation/?'), true);
  token = rb.token;

  const reg = await db.selectOne('wr_registrations', { select:'id,session_id,email,consent_at,data', token:`eq.${token}` });
  regId = reg.id; sessionId = reg.session_id;
  eq('register: row stored', reg.email, EMAIL);
  eq('register: consent recorded', !!reg.consent_at, true);
  eq('register: utm captured', reg.data.utm.utm_content, 'a1');

  // --- 3. the email queue ---
  const q = await db.select('wr_notifications', { select:'template,status,scheduled_for,segments', registration_id:`eq.${regId}`, order:'scheduled_for.asc' });
  console.log('\n     queue:');
  for (const n of q) console.log(`       ${n.template.padEnd(6)} ${n.status.padEnd(10)} ${n.scheduled_for}`);
  eq('queue: one row per configured email', q.length, 19);
  const pending = q.filter(n=>n.status==='pending').map(n=>n.template);
  const skipped = q.filter(n=>n.status==='skipped').map(n=>n.template);
  eq('queue: E1 is pending, not skipped', pending.includes('E1'), true);
  // The session is minutes away, so the 6h/1h reminders are in the past and must never be sent late.
  eq('queue: E2 skipped as already past', skipped.includes('E2'), true);
  eq('queue: E3 skipped as already past', skipped.includes('E3'), true);
  eq('queue: post-session emails still pending', pending.includes('E9'), true);

  // --- 4. the room, before it starts ---
  const { default: room } = await import(B + 'wr-room.js');
  const er = await room(new Request(URL_BASE + `wr-room?t=${token}`));
  const eb = await er.json();
  eq('room: early state before start', eb.state, 'early');
  eq('room: hides the video before start', eb.videoUrl, undefined);

  // --- 5. move the session into the past so the room goes live ---
  const started = new Date(Date.now() - 45*60*1000).toISOString();
  await db.update('wr_sessions', { id:`eq.${sessionId}` }, { starts_at: started });
  const lr = await room(new Request(URL_BASE + `wr-room?t=${token}`));
  const lb = await lr.json();
  eq('room: live once started', lb.state, 'live');
  eq('room: position is ~45 min in', Math.abs(lb.positionSec - 2700) < 30, true);
  eq('room: seeking disabled', lb.allowSeek, false);
  eq('room: flags a late join', lb.lateJoin, true);
  eq('room: chat stays off', lb.elements.chat.enabled, false);
  eq('room: attendee counter stays off', lb.elements.attendeeCounter.enabled, false);

  // --- 5b. reloading the room must not reset the clock ---
  const before = await db.selectOne('wr_attendance', { select:'first_seen_at,joined_at_position_sec', registration_id:`eq.${regId}` });
  await room(new Request(URL_BASE + `wr-room?t=${token}`));
  await room(new Request(URL_BASE + `wr-room?t=${token}`));
  const after = await db.selectOne('wr_attendance', { select:'first_seen_at,joined_at_position_sec', registration_id:`eq.${regId}` });
  eq('reload: first_seen_at is not reset', after.first_seen_at, before.first_seen_at);
  eq('reload: late-join position preserved', after.joined_at_position_sec, before.joined_at_position_sec);
  const joins = await db.select('wr_events', { select:'id', registration_id:`eq.${regId}`, type:'eq.join' });
  eq('reload: one join event, not three', joins.length, 1);

  // Back-date the arrival so this viewer has genuinely been present for 50 minutes. Without
  // this the clamp correctly refuses to credit 45 minutes of watching to someone who turned
  // up four seconds ago - which is exactly what it is for.
  await db.update('wr_attendance', { registration_id:`eq.${regId}` }, { first_seen_at: new Date(Date.now() - 50*60*1000).toISOString() });

  // --- 6. heartbeat and segments ---
  const { default: beat } = await import(B + 'wr-heartbeat.js');
  const hit = async (watched, phase='live', event) => {
    const r = await beat(new Request(URL_BASE + 'wr-heartbeat', { method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ t: token, positionSec: watched, watchedSec: watched, phase, event })}));
    return r.status;
  };

  // Below bounceSec, a peek is filed as a no-show so the rebook chain picks it up (2026-08-14).
  await hit(180);
  let a = await db.selectOne('wr_attendance', { select:'watched_sec,segments', registration_id:`eq.${regId}` });
  eq('beat: 3 min watched -> bounced, not no-show', a.segments, ['SEG-A-bounced']);

  await hit(600);
  a = await db.selectOne('wr_attendance', { select:'watched_sec,segments', registration_id:`eq.${regId}` });
  eq('beat: 10 min watched -> pre-reveal', a.segments, ['SEG-B-pre-reveal']);

  await hit(1400);
  a = await db.selectOne('wr_attendance', { select:'watched_sec,segments', registration_id:`eq.${regId}` });
  eq('beat: past the reveal -> pre-offer + saw-reveal', a.segments, ['SEG-C-pre-offer','SEG-SAW-REVEAL','SEG-CLOSE']);

  await hit(2600);
  a = await db.selectOne('wr_attendance', { select:'watched_sec,segments', registration_id:`eq.${regId}` });
  eq('beat: past the offer -> stayed', a.segments, ['SEG-D-stayed','SEG-SAW-REVEAL','SEG-CLOSE']);

  // The clamp: claim the whole session in one call.
  await hit(999999);
  a = await db.selectOne('wr_attendance', { select:'watched_sec', registration_id:`eq.${regId}` });
  eq('beat: absurd claim clamped to real elapsed time', a.watched_sec <= 5400, true);
  console.log(`     stored watched_sec after claiming 999999: ${a.watched_sec}`);

  // --- 7. notify: does the buyer guard hold? ---
  const { default: notify } = await import(B + 'wr-notify.js');
  await db.update('wr_registrations', { id:`eq.${regId}` }, { purchased_at: new Date().toISOString() });
  await db.update('wr_notifications', { registration_id:`eq.${regId}`, template:'eq.E7' }, { scheduled_for: new Date(Date.now()-1000).toISOString() });
  // Delivery is MailerLite now (2026-08-14). Point the API base at an unreachable host so the
  // notify step exercises the whole path but no real subscriber is ever touched: a failed send
  // stays `pending`, which is the same contract the old webhook had.
  process.env.MAILERLITE_API_KEY = process.env.MAILERLITE_API_KEY || 'selftest';
  process.env.MAILERLITE_API_BASE = 'https://example.invalid/never-called';
  const nr = await notify();
  const nb = await nr.json();
  const e7 = await db.selectOne('wr_notifications', { select:'status', registration_id:`eq.${regId}`, template:'eq.E7' });
  eq('notify: a buyer is never pitched', e7.status, 'skipped');
  console.log(`     notify run: sent ${nb.sent}, skipped ${nb.skipped}, failed ${nb.failed}`);

  // --- 7b. the no-sales guard: E13's one-click promise ---
  //
  // no_sales must silence exactly the templates flagged `sales: true` and nothing else. The
  // buyer flag from step 7 is cleared first - it would shadow the guard under test.
  await db.update('wr_registrations', { id:`eq.${regId}` }, { purchased_at: null, no_sales: true });
  await db.update('wr_notifications', { registration_id:`eq.${regId}`, template:'eq.E12' }, { status: 'pending', scheduled_for: new Date(Date.now()-1000).toISOString() });
  await db.update('wr_notifications', { registration_id:`eq.${regId}`, template:'eq.E6' }, { status: 'pending', scheduled_for: new Date(Date.now()-1000).toISOString() });
  await notify();
  const e12 = await db.selectOne('wr_notifications', { select:'status', registration_id:`eq.${regId}`, template:'eq.E12' });
  eq('notify: no-sales silences a price email', e12.status, 'skipped');
  const e6 = await db.selectOne('wr_notifications', { select:'status,error', registration_id:`eq.${regId}`, template:'eq.E6' });
  eq('notify: no-sales keeps the useful stuff (E6 attempted, not skipped)', e6.status, 'pending');

  // --- 8. the no-show, who is the largest group in any webinar funnel ---
  //
  // Segments are written by wr-heartbeat, and wr-heartbeat only ever hears from someone who
  // opened the room. Somebody who never opened it has no attendance row at all, so their segment
  // list used to come back empty - and an empty list intersects with nothing, so E9 and E8-B were
  // silently marked `skipped` for precisely the people they were written for. Fixed on
  // 2026-08-13 and never covered by a test until now.
  const noShowEmail = `wr-selftest-noshow-${Date.now()}@thezerofog.com`;
  const nsr = await register(new Request(URL_BASE + 'wr-register', { method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ email: noShowEmail, startsAt: chosen.startsAt, kind: chosen.kind, tz:'America/New_York', consent:true })}));
  const nsBody = await nsr.json();
  const nsReg = await db.selectOne('wr_registrations', { select:'id', email:`eq.${noShowEmail}` });

  const nsAttendance = await db.select('wr_attendance', { select:'registration_id', registration_id:`eq.${nsReg.id}` });
  eq('no-show: never opened the room, so no attendance row exists', (nsAttendance||[]).length, 0);

  // Make E9 due and drain the queue. It must be attempted, not skipped.
  await db.update('wr_notifications', { registration_id:`eq.${nsReg.id}`, template:'eq.E9' }, { scheduled_for: new Date(Date.now()-1000).toISOString() });
  await notify();
  const e9 = await db.selectOne('wr_notifications', { select:'status', registration_id:`eq.${nsReg.id}`, template:'eq.E9' });
  eq('no-show: E9 is not skipped for someone with no attendance row', e9.status === 'skipped', false);
  console.log(`     E9 for a no-show ended as: ${e9.status}`);

  // --- 9. registering again must not inherit the last session's watching ---
  //
  // `registration_id` is reused when a registration is replaced, and wr_attendance hangs off it.
  // watched_sec is written with Math.max on purpose, so a reload cannot roll the counter back -
  // and through a re-registration that same shield used to carry the old total into the new
  // session. Someone who watched 40 minutes and then skipped the next session still came out as
  // SEG-D-stayed and got the closing sequence for a session they were not at.
  await db.upsert('wr_attendance', {
    registration_id: nsReg.id,
    first_seen_at: new Date(Date.now() - 60*60*1000).toISOString(),
    last_seen_at: new Date().toISOString(),
    watched_sec: 2600,
    max_position_sec: 2600,
    segments: ['SEG-D-stayed'],
  }, 'registration_id');

  const again = await register(new Request(URL_BASE + 'wr-register', { method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ email: noShowEmail, startsAt: chosen.startsAt, kind: chosen.kind, tz:'America/New_York', consent:true })}));
  eq('re-register: accepted', again.status, 200);
  const afterRe = await db.select('wr_attendance', { select:'watched_sec,segments', registration_id:`eq.${nsReg.id}` });
  eq('re-register: the old attendance row is gone, not carried forward', (afterRe||[]).length, 0);

  await db.remove('wr_registrations', { id:`eq.${nsReg.id}` });

  // --- 10. a bad token must reveal nothing ---
  const br = await room(new Request(URL_BASE + 'wr-room?t=' + 'x'.repeat(32)));
  eq('room: unknown token -> 404', br.status, 404);

} catch (err) {
  fail++; console.log('THREW:', err.message, '\n', err.stack);
} finally {
  // --- cleanup: the registration cascades to attendance, events and the queue ---
  if (regId) { await db.remove('wr_registrations', { id:`eq.${regId}` }); console.log('\ncleanup: registration deleted'); }
  if (sessionId) { await db.remove('wr_sessions', { id:`eq.${sessionId}` }); console.log('cleanup: test session deleted'); }
  const left = await db.select('wr_registrations', { select:'id', email:`eq.${EMAIL}` });
  console.log('cleanup: rows left behind =', (left||[]).length);
}

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASSED');
process.exit(fail?1:0);
