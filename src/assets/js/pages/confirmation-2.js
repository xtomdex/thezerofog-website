// confirmation-2.js - runs on /confirmation/ after our own schedule step registers someone.
// (Filename kept from 2026-07-14: a rename plus a content change together defeat Netlify's hash
// dedupe, which once re-served a stale artifact for an unchanged file. Not worth re-testing.)
//
// Rewritten 2026-08-13. It used to read EverWebinar's wj_* parameters, which nothing ever sent -
// so the greeting, the registrant details and the add-to-calendar buttons were dead code on a
// live page. The parameters are ours now and they do arrive:
//
//   t     - the join token
//   slot  - session start, ISO 8601 in UTC
//   tz    - the timezone the visitor picked in
//   when  - the human label they saw when picking, e.g. "Today at 7:00 PM EDT"
//   dur   - session length in minutes
//   name  - optional
//
// The address is NOT in the URL by design; it comes from sessionStorage and is cleared here.
//
// SECURITY: every value below is attacker-controllable, because it comes from the query string.
// It is injected with textContent only - never innerHTML - and the join link is rebuilt from our
// own origin plus the token rather than taken from a parameter.

(function () {
  var params = new URLSearchParams(window.location.search);

  var token = (params.get('t') || '').trim();
  var slotIso = (params.get('slot') || '').trim();
  var when = (params.get('when') || '').trim();
  var firstName = (params.get('name') || '').trim();
  var durationMin = parseInt(params.get('dur') || '90', 10);
  if (!(durationMin > 0 && durationMin < 600)) durationMin = 90;

  // --- 1. Who they are ---

  var email = '';
  try {
    email = sessionStorage.getItem('zf_workshop_email') || '';
    // Read once. Leaving it behind would show a stale address to whoever opens this tab next.
    sessionStorage.removeItem('zf_workshop_email');
  } catch (err) {}

  if (email) {
    var emailEl = document.getElementById('regEmail');
    var detailsEl = document.getElementById('regDetails');
    if (emailEl && detailsEl) {
      emailEl.textContent = email;
      detailsEl.classList.remove('hidden');
    }
  }

  if (firstName) {
    var nameEl = document.getElementById('regName');
    var greetEl = document.getElementById('regGreeting');
    if (nameEl && greetEl) {
      nameEl.textContent = firstName;
      greetEl.classList.remove('hidden');
    }
  }

  // --- 2. The time they picked ---

  var slotEl = document.getElementById('regSlot');
  if (slotEl && when) {
    slotEl.textContent = when;
    slotEl.classList.remove('hidden');
  }

  // --- 3. The join link ---
  //
  // Built from our own origin and the token rather than read from a parameter, so a crafted URL
  // cannot turn this button into a link to somewhere else.

  var joinEl = document.getElementById('regJoin');
  if (joinEl && /^[A-Za-z0-9_-]{16,}$/.test(token)) {
    joinEl.href = '/workshop/room/?t=' + encodeURIComponent(token);
    joinEl.classList.remove('hidden');
  }

  // --- 4. Device-aware message ---
  // Conservative detection: require BOTH a coarse pointer AND a mobile UA token before flipping
  // to the mobile variant. When uncertain, fall through to desktop.
  var ua = navigator.userAgent || '';
  var coarsePointer =
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  var mobileToken = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  var isMobile = coarsePointer && mobileToken;

  var deviceEl = document.getElementById(isMobile ? 'deviceMobile' : 'deviceDesktop');
  if (deviceEl) deviceEl.classList.remove('hidden');

  // --- 5. Add to calendar ---
  //
  // "Workshop", never "webinar" or "live" - CEO 2026-08-11 on the naming, and the standing rule
  // that we never assert a session is live.

  var EVENT_TITLE = 'The Zero Fog Workshop';

  function toCalStamp(d) {
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  }

  function icsEscape(s) {
    return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  }

  var start = slotIso ? new Date(slotIso) : null;
  if (start && isNaN(start.getTime())) start = null;

  var btnsEl = document.getElementById('calBtns');
  var googleEl = document.getElementById('calGoogle');
  var icsEl = document.getElementById('calIcs');

  if (start && btnsEl && googleEl && icsEl) {
    var end = new Date(start.getTime() + durationMin * 60000);
    var joinUrl = token ? window.location.origin + '/workshop/room/?t=' + token : '';

    var description = joinUrl
      ? 'Your personal link: ' + joinUrl + '\nA desktop or laptop works best.'
      : 'Your link is in your email.\nA desktop or laptop works best.';

    var stamps = toCalStamp(start) + '/' + toCalStamp(end);
    googleEl.href =
      'https://calendar.google.com/calendar/render?action=TEMPLATE' +
      '&text=' + encodeURIComponent(EVENT_TITLE) +
      '&dates=' + encodeURIComponent(stamps) +
      '&details=' + encodeURIComponent(description);

    var ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//The Zero Fog//Confirmation//EN',
      'BEGIN:VEVENT',
      'UID:' + toCalStamp(start) + '@thezerofog.com',
      'DTSTAMP:' + toCalStamp(new Date()),
      'DTSTART:' + toCalStamp(start),
      'DTEND:' + toCalStamp(end),
      'SUMMARY:' + icsEscape(EVENT_TITLE),
      'DESCRIPTION:' + icsEscape(description),
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    icsEl.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
    btnsEl.classList.remove('hidden');
  }
})();
