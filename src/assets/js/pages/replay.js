// The replay entry point.
//
// This file used to run the countdown itself: 48 hours from the first visit, kept in
// localStorage. It had two defects that a July legal review flagged as deceptive urgency under
// FTC Section 5, and both are gone with it:
//
//   1. Reaching zero changed the text to "Expired" and then served the video and the $67 button
//      anyway. The deadline expired; nothing else did.
//   2. `stored > now` failed once the stored time had passed, so the next visit wrote a fresh
//      48 hours. The countdown restarted itself for anyone who came back.
//
// There is no timer here now. The replay lives in the room, where the deadline is computed on
// the server from the session that person actually registered for, and where it genuinely closes.

(function () {
  var token = new URLSearchParams(window.location.search).get('t');

  if (token) {
    // view=replay is what makes the room serve the replay at all. Without it the room shows the
    // end of the session and the offer - see wr-room.js. This page is the only door to the
    // replay, and the link in the E9/E10-B emails points here.
    window.location.replace('/workshop/room/?t=' + encodeURIComponent(token) + '&view=replay');
    return;
  }

  // No token: this is someone who typed the address, or followed an old link. There is nothing
  // to show them - the replay is tied to a person and a session - so say that plainly rather
  // than presenting a play button that cannot work.
  var el = document.getElementById('replayMessage');
  if (el) el.hidden = false;
})();
