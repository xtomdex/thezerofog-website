// Live presence from the room's own join/exit events.
//
// The heartbeat counter (`watched_sec`) only grows while the player reports "playing" every
// twenty seconds. On a phone with the screen off or the app in the background those beats stop
// while the stream keeps running, so a person who sat to the end can be credited with two thirds
// of it. That happened on 2026-09-02: 2472 s counted, playhead at 3487 s, the offer event on
// record, and the person was filed as "left before the offer" and mailed as such. The join/exit
// events carry the playhead position at both ends of every stretch in the room, and in a live
// session the playhead cannot be dragged, so the sum of those stretches is the honest floor for
// "seconds this person had the session in front of them". The heartbeat keeps the larger of the
// two, still clamped against wall-clock time, so a forged exit position buys nothing.
export function livePresenceSec(events, { currentPositionSec = 0, maxPositionSec = 0 } = {}) {
  // `pause`/`resume` bound a stretch the same way `join`/`exit` do: a phone that goes to the
  // background pauses the player, and the seconds until it comes back are not attendance even
  // though the room page stayed open. A stretch is also capped by the wall-clock time between
  // its two events, so the live resync jump on return (the player is pulled forward to the live
  // position) cannot be credited as watching.
  const OPENERS = new Set(['join', 'resume']);
  const CLOSERS = new Set(['exit', 'pause']);
  const rows = (events || [])
    .filter((e) => e && (OPENERS.has(e.type) || CLOSERS.has(e.type)))
    .map((e) => ({
      type: OPENERS.has(e.type) ? 'join' : 'exit',
      pos: Number(e.position_sec) || 0,
      at: new Date(e.created_at).getTime() || 0,
    }))
    .sort((a, b) => a.at - b.at);

  let total = 0;
  let open = null; // the stretch currently open: { pos, at }

  for (const e of rows) {
    if (e.type === 'join') {
      if (open === null) {
        open = e;
        continue;
      }
      // A second join while one is open. Within a minute it is a reconnect and the stretch goes
      // on; any later it is a stretch that never got its exit - credit nothing for it rather
      // than guess, and start again from here. The heartbeat counter still covers that gap.
      if (e.at - open.at > 60_000) open = e;
      continue;
    }
    // exit: closes the open stretch when it lies ahead of the join. An exit below the join
    // position (the player reset to 0 after the video ended, or a stray beacon) closes nothing.
    // A stretch can never be longer than the wall-clock time between its two events, so a
    // forged exit position buys at most the seconds that really passed.
    if (open !== null && e.pos >= open.pos) {
      const wall = Math.max(0, Math.round((e.at - open.at) / 1000)) + 60;
      total += Math.min(e.pos - open.pos, wall);
      open = null;
    }
  }

  if (open !== null) {
    const end = Math.max(Number(currentPositionSec) || 0, Number(maxPositionSec) || 0);
    if (end >= open.pos) total += end - open.pos;
  }

  return total;
}
