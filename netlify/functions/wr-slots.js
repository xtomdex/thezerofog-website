// GET /.netlify/functions/wr-slots?tz=America/New_York
//
// The bookable sessions, described in the visitor's own timezone. Read-only: it creates nothing.
// A session row only comes into existence when somebody actually registers for a slot, which
// keeps the table free of the thousands of empty sessions a rolling schedule would otherwise
// generate.

import { json, preflight, select } from './lib/wr-db.js';
import { loadConfig } from './lib/wr-config.js';
import {
  describeSlot,
  isValidTimeZone,
  nextJitSlot,
  scheduledSlots,
  zonedDateParts,
} from './lib/wr-time.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export default async function handler(req) {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error('wr-slots: config load failed:', err.message);
    return json({ error: 'Server configuration error' }, 500);
  }

  const { schedule } = config;

  if (!schedule.registrationsOpen) {
    return json({ ok: true, open: false, redirect: schedule.closedRedirect, slots: [] });
  }

  // Whose clock do we speak in? The browser sends its IANA zone; anything we do not recognise
  // falls back to the configured zone rather than to UTC, which would show Americans their
  // sessions five hours out and look like a bug.
  const requested = new URL(req.url).searchParams.get('tz');
  const viewerZone =
    schedule.timezoneMode === 'fixed' || !isValidTimeZone(requested)
      ? schedule.fixedTimeZone
      : requested;

  const now = new Date();

  let blockedDates = [];
  let sessions = [];
  try {
    const windowEnd = new Date(now.getTime() + (schedule.maxDaysAhead + 1) * DAY_MS);
    const [blockedRows, sessionRows] = await Promise.all([
      select('wr_blocked_dates', {
        select: 'blocked_on',
        blocked_on: `gte.${zonedDateParts(now, schedule.fixedTimeZone).iso}`,
      }),
      select('wr_sessions', {
        select: 'id,starts_at,kind,cap,registrant_count',
        starts_at: `gte.${now.toISOString()}`,
        and: `(starts_at.lte.${windowEnd.toISOString()})`,
      }),
    ]);
    blockedDates = (blockedRows || []).map((r) => r.blocked_on);
    sessions = sessionRows || [];
  } catch (err) {
    // A degraded schedule is better than no schedule: without the blocked-date list we would
    // rather offer a session on a blocked day than show a visitor an empty page.
    console.error('wr-slots: falling back to an unfiltered schedule:', err.message);
  }

  // Sessions already at capacity must not be offered again.
  const full = new Set(
    sessions
      .filter((s) => s.cap && s.registrant_count >= s.cap)
      .map((s) => new Date(s.starts_at).getTime())
  );

  const candidates = [];

  if (schedule.jit.enabled) {
    const jit = nextJitSlot(now, {
      intervalMin: schedule.jit.intervalMin,
      minLeadMinutes: schedule.minLeadMinutes,
    });
    const blockedToday = blockedDates.includes(zonedDateParts(jit, schedule.fixedTimeZone).iso);
    if (!blockedToday && !full.has(jit.getTime())) candidates.push({ instant: jit, kind: 'jit' });
  }

  for (const instant of scheduledSlots(now, {
    rules: schedule.recurring,
    daysAhead: schedule.maxDaysAhead,
    minLeadMinutes: schedule.minLeadMinutes,
    blockedDates,
  })) {
    if (full.has(instant.getTime())) continue;
    // The JIT slot can coincide with a scheduled one; the visitor must see it once.
    if (candidates.some((c) => c.instant.getTime() === instant.getTime())) continue;
    candidates.push({ instant, kind: 'scheduled' });
  }

  candidates.sort((a, b) => a.instant - b.instant);

  const slots = candidates.slice(0, schedule.displaySlots).map(({ instant, kind }) => ({
    ...describeSlot(instant, viewerZone, now),
    kind,
    // The JIT slot is the one that carries the show-up rate, so it is labelled by how soon it is
    // rather than by a clock time nobody reads.
    urgent: kind === 'jit',
  }));

  const payload = {
    ok: true,
    open: true,
    timeZone: viewerZone,
    slots,
  };

  if (schedule.onDemand.enabled) {
    payload.onDemand = { available: true };
  }

  return json(payload, 200, {
    // Short enough that a JIT slot never goes stale, long enough to absorb a burst from an ad.
    'Cache-Control': 'no-store',
  });
}
