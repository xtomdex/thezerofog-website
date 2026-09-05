// Recompute live attendance from join/exit events and compare with the stored segments.
//
//   node scripts/wr-presence-audit.mjs            dry run: prints old vs new per attendance row
//   node scripts/wr-presence-audit.mjs --apply    writes watched_sec + segments where they change
//
// Reads .env (gitignored). Only touches wr_attendance rows whose result differs.

import fs from 'node:fs';
for (const line of fs.readFileSync('/Users/Cyrill/AI SANDBOX/thezerofog-website/.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && m[2]) process.env[m[1]] = m[2].trim();
}
const B = '/Users/Cyrill/AI SANDBOX/thezerofog-website/netlify/functions/';
const { select, update } = await import(B + 'lib/wr-db.js');
const { loadConfig, deriveSegments } = await import(B + 'lib/wr-config.js');
const { livePresenceSec } = await import(B + 'lib/wr-presence.js');

const apply = process.argv.includes('--apply');
// --only=<registration_id> limits the write (and the listing) to one row.
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7) || null;
const config = await loadConfig();
const { revealSec, offerSec, thresholdGraceSec, bounceSec } = config.timecodes;
const duration = config.video.durationSec;

const att = await select('wr_attendance', { select: '*', order: 'first_seen_at.asc' });
const regs = await select('wr_registrations', { select: 'id,email' });
const emailOf = Object.fromEntries(regs.map((r) => [r.id, r.email]));
const events = await select('wr_events', { select: 'registration_id,type,position_sec,created_at', order: 'created_at.asc' });
const byReg = {};
for (const e of events) (byReg[e.registration_id] ||= []).push(e);

const mask = (e) => (e ? e[0] + '***@' + e.split('@')[1] : '?');
let changed = 0;
for (const a of att) {
  if (only && a.registration_id !== only) continue;
  const evs = byReg[a.registration_id] || [];
  const presence = livePresenceSec(evs, { maxPositionSec: a.max_position_sec || 0 });
  const wall = Math.max(0, Math.round((new Date(a.last_seen_at) - new Date(a.first_seen_at)) / 1000)) + 60;
  const live = Math.min(Math.max(a.watched_sec || 0, presence), wall, duration);
  const replay = a.replay_watched_sec || 0;
  const segments = deriveSegments({
    attended: live >= bounceSec,
    bounced: live > 0 && live < bounceSec,
    watchedToRevealSec: live >= revealSec - thresholdGraceSec,
    watchedToOfferSec: live >= offerSec - thresholdGraceSec,
    replayEarned: replay >= revealSec - thresholdGraceSec || evs.some((e) => e.type === 'bonus_click'),
  });
  const oldSeg = Array.isArray(a.segments) ? a.segments : [];
  const same = live === (a.watched_sec || 0) && JSON.stringify(oldSeg) === JSON.stringify(segments);
  console.log(
    `${mask(emailOf[a.registration_id])}  watched ${a.watched_sec}  presence ${presence}  max_pos ${a.max_position_sec}  wall ${wall - 60}` +
      `  -> live ${live}  ${same ? 'unchanged' : 'CHANGED'}  ${oldSeg.join(',')}  =>  ${segments.join(',')}`
  );
  if (!same) {
    changed += 1;
    if (apply) {
      await update('wr_attendance', { registration_id: `eq.${a.registration_id}` }, { watched_sec: live, segments, total_watched_sec: live + replay });
      console.log('   applied');
    }
  }
}
console.log(`rows ${att.length}, changed ${changed}${apply ? ' (applied)' : ' (dry run)'}`);
