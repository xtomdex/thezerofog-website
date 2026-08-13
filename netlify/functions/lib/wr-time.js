// Workshop Room - timezone and slot maths.
//
// No dependencies by design: the rest of this project's functions run on native fetch and
// node:crypto, and this file keeps that rule. Everything below is built on Intl, which Node 22
// ships with full ICU, so named IANA zones and their DST rules are available without a library.
//
// This file lives in `lib/` rather than at the top of `netlify/functions/` on purpose: Netlify
// registers every top-level file in that directory as a deployable function, and a subdirectory
// without a matching index file is left alone. These are helpers, not endpoints.

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/**
 * The offset of `timeZone` from UTC, in minutes, at a given instant.
 * Positive east of Greenwich (Berlin in summer = +120).
 *
 * Works by asking Intl to describe the instant in that zone, reading the wall-clock fields back
 * as if they were UTC, and taking the difference. This is the standard trick and it is exact for
 * whole-minute offsets, which every IANA zone in current use has.
 */
export function zoneOffsetMinutes(instant, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = {};
  for (const { type, value } of dtf.formatToParts(instant)) {
    if (type !== 'literal') parts[type] = value;
  }

  // Intl renders midnight as hour 24 in some locales/zones; normalise it.
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second)
  );

  return Math.round((asUtc - instant.getTime()) / MINUTE);
}

/**
 * Turn a wall-clock time in `timeZone` into the real UTC instant.
 *
 * The naive version of this is wrong twice a year, so it is done in two passes: guess using the
 * offset that applies at the naive instant, then re-read the offset at the guessed instant and
 * correct.
 *
 * The correction is then CHECKED by formatting it back. That check is not decoration - on the
 * spring-forward morning the requested wall clock does not exist at all, and the corrected pass
 * silently lands an hour BEFORE the time that was asked for. A 2:30am slot would quietly become
 * 1:30am. When the round-trip fails we are in that gap, and the first-pass instant - which sits
 * after the jump - is the right answer, matching the "compatible" disambiguation every serious
 * date library uses.
 *
 * In the autumn overlap (a wall clock that happens twice) this returns the first occurrence.
 */
export function zonedWallClockToUtc({ year, month, day, hour, minute }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);

  const firstOffset = zoneOffsetMinutes(new Date(naive), timeZone);
  const firstPass = new Date(naive - firstOffset * MINUTE);

  const secondOffset = zoneOffsetMinutes(firstPass, timeZone);
  if (secondOffset === firstOffset) return firstPass;

  const secondPass = new Date(naive - secondOffset * MINUTE);

  // Did we actually land on the wall clock we were asked for?
  const landed = zonedDateParts(secondPass, timeZone);
  const landedTime = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(secondPass);
  const wanted = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  const roundTripped =
    landed.day === day && landed.month === month && landed.year === year && landedTime === wanted;

  return roundTripped ? secondPass : firstPass;
}

/** The calendar date (in `timeZone`) that an instant falls on. */
export function zonedDateParts(instant, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });

  const parts = {};
  for (const { type, value } of dtf.formatToParts(instant)) {
    if (type !== 'literal') parts[type] = value;
  }

  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: weekdayIndex, // 0 = Sunday, matching JS getDay()
    iso: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** True when `timeZone` is a real IANA zone this runtime knows. */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The next Just-in-Time slot: the soonest multiple of `intervalMin` that is at least
 * `minLeadMinutes` away. Anchored to the top of the hour in UTC, so every visitor in the world is
 * offered the same instants and two people landing a second apart get the same session rather
 * than two sessions one second apart.
 */
export function nextJitSlot(now, { intervalMin, minLeadMinutes }) {
  const earliest = now.getTime() + minLeadMinutes * MINUTE;
  const step = intervalMin * MINUTE;
  const hourStart = Math.floor(now.getTime() / (60 * MINUTE)) * 60 * MINUTE;

  let slot = hourStart;
  while (slot < earliest) slot += step;

  return new Date(slot);
}

/**
 * Every scheduled slot inside the window, as UTC instants.
 *
 * `rules` is a list of `{ days: [0-6], times: ['19:00'], timeZone }`. Days are indexed from
 * Sunday to match `zonedDateParts().weekday`. The times are wall-clock in the rule's own zone,
 * which is what makes "always 7pm Eastern" hold across a DST change instead of drifting an hour.
 */
export function scheduledSlots(now, { rules, daysAhead, minLeadMinutes, blockedDates = [] }) {
  const out = [];
  const earliest = now.getTime() + minLeadMinutes * MINUTE;
  const blocked = new Set(blockedDates);

  for (const rule of rules) {
    const zone = rule.timeZone;
    if (!isValidTimeZone(zone)) continue;

    // Start a day early: a slot late "yesterday" in a far-eastern zone can still be ahead of us.
    for (let offset = -1; offset <= daysAhead; offset += 1) {
      const date = zonedDateParts(new Date(now.getTime() + offset * DAY), zone);

      if (Array.isArray(rule.days) && !rule.days.includes(date.weekday)) continue;
      if (blocked.has(date.iso)) continue;

      for (const time of rule.times) {
        const [hour, minute] = time.split(':').map(Number);
        if (!Number.isInteger(hour) || !Number.isInteger(minute)) continue;

        const instant = zonedWallClockToUtc(
          { year: date.year, month: date.month, day: date.day, hour, minute },
          zone
        );

        if (instant.getTime() < earliest) continue;
        if (instant.getTime() > now.getTime() + daysAhead * DAY) continue;

        out.push(instant);
      }
    }
  }

  // Two rules can legitimately land on the same instant; the visitor must see it once.
  const unique = [...new Set(out.map((d) => d.getTime()))].sort((a, b) => a - b);
  return unique.map((ms) => new Date(ms));
}

/**
 * Hold a send until it falls inside the recipient's waking hours.
 *
 * A 9am session puts its six-hour reminder at 3am local. EverWebinar calls this smart delivery;
 * here it is a pure function: given an instant and the recipient's zone, return the same instant
 * if it is already inside the window, otherwise the moment the window next opens.
 *
 * Deliberately one-directional. Something scheduled for 2am is pushed forward to 7am - it is
 * never pulled backwards, because a reminder must not arrive before the thing it reminds you of
 * was decided.
 */
export function applyDeliveryWindow(instant, timeZone, { startHour, endHour }) {
  if (!isValidTimeZone(timeZone)) return instant;

  const localHour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(instant)
  );

  if (localHour >= startHour && localHour < endHour) return instant;

  // Before the window opens today -> this morning. After it closes -> tomorrow morning.
  const date = zonedDateParts(instant, timeZone);
  const targetDay =
    localHour < startHour ? date : zonedDateParts(new Date(instant.getTime() + DAY), timeZone);

  return zonedWallClockToUtc(
    { year: targetDay.year, month: targetDay.month, day: targetDay.day, hour: startHour, minute: 0 },
    timeZone
  );
}

/** How a slot should read to a human in their own zone: "Today at 7:00 PM", "Thu, Aug 14, 7:00 PM". */
export function describeSlot(instant, viewerZone, now) {
  const slotDate = zonedDateParts(instant, viewerZone);
  const todayDate = zonedDateParts(now, viewerZone);
  const tomorrowDate = zonedDateParts(new Date(now.getTime() + DAY), viewerZone);

  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: viewerZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(instant);

  const zoneLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: viewerZone,
    timeZoneName: 'short',
  })
    .formatToParts(instant)
    .find((p) => p.type === 'timeZoneName')?.value;

  let dayLabel;
  if (slotDate.iso === todayDate.iso) dayLabel = 'Today';
  else if (slotDate.iso === tomorrowDate.iso) dayLabel = 'Tomorrow';
  else {
    dayLabel = new Intl.DateTimeFormat('en-US', {
      timeZone: viewerZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(instant);
  }

  const minutesAway = Math.round((instant.getTime() - now.getTime()) / MINUTE);

  return {
    startsAt: instant.toISOString(),
    dayLabel,
    time,
    zoneLabel,
    label: `${dayLabel} at ${time}${zoneLabel ? ` ${zoneLabel}` : ''}`,
    minutesAway,
  };
}
