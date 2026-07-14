// confirmation-2.js — runs on /confirmation/ after EverWebinar redirects post-registration.
// (Renamed from confirmation.js 2026-07-14: rename + content change together defeat
// Netlify's hash dedupe, which re-served stale artifacts for unchanged files.)
//
// Three jobs: populate registrant details from wj_lead_* URL params, reveal the
// correct device-strategy message (desktop vs mobile), and build add-to-calendar
// links from the event params EverWebinar appends when "Send register information
// and webinar information" is ON: wj_event_ts, wj_event_tz, wj_next_event_date,
// wj_next_event_time, wj_next_event_timezone, wj_lead_unique_link_live_room.
//
// NOTE: the exact wj_event_ts format is not fixed in WebinarJam docs — this code
// accepts unix seconds, unix milliseconds, or a Date.parse()-able string, and the
// wj_next_event_* pair as a fallback. Verify against a real test registration
// before trusting the calendar buttons in production; on any parse failure the
// buttons simply stay hidden.
//
// SECURITY: all wj_* values come from the URL and are attacker-controllable. They
// MUST be injected via textContent only — never innerHTML / insertAdjacentHTML.
// The join link is embedded in calendar-event text (URL-encoded), never rendered
// as a clickable href on the page, and only if it is a plain https:// URL.

(function () {
  // --- 1. Registrant details from EverWebinar URL params ---
  var params = new URLSearchParams(window.location.search);
  var firstName = (params.get('wj_lead_first_name') || '').trim();
  var email = (params.get('wj_lead_email') || '').trim();

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

  // --- 2. Device-aware message ---
  // Conservative detection: require BOTH a coarse pointer AND a mobile UA token
  // before flipping to the mobile variant. When uncertain, fall through to desktop
  // since desktop is the primary conversion device for the webinar.
  var ua = navigator.userAgent || '';
  var coarsePointer =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;
  var mobileToken =
    /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  var isMobile = coarsePointer && mobileToken;

  var targetId = isMobile ? 'deviceMobile' : 'deviceDesktop';
  var deviceEl = document.getElementById(targetId);
  if (deviceEl) {
    deviceEl.classList.remove('hidden');
  }

  // --- 3. Add-to-calendar buttons ---
  var EVENT_TITLE = 'The Zero Fog - Live Training';
  var EVENT_MINUTES = 60;

  function parseEventStart() {
    // Preferred: wj_event_ts as a unix timestamp (timezone-independent).
    var ts = (params.get('wj_event_ts') || '').trim();
    if (/^\d+$/.test(ts)) {
      var n = parseInt(ts, 10);
      if (n > 1e12) n = Math.floor(n / 1000); // milliseconds → seconds
      // Sanity window: 2020–2040, otherwise treat as unparsed.
      if (n > 1577836800 && n < 2208988800) return new Date(n * 1000);
    }
    if (ts) {
      var parsedTs = new Date(ts);
      if (!isNaN(parsedTs.getTime())) return parsedTs;
    }
    // Fallback: wj_next_event_date + wj_next_event_time, parsed in the browser's
    // local timezone (EverWebinar shows registrants times in their own timezone,
    // so local interpretation matches what they saw when registering).
    var date = (params.get('wj_next_event_date') || '').trim();
    var time = (params.get('wj_next_event_time') || '').trim();
    if (date && time) {
      var parsed = new Date(date + ' ' + time);
      if (!isNaN(parsed.getTime())) return parsed;
    }
    return null;
  }

  function toCalStamp(d) {
    // UTC basic format: YYYYMMDDTHHMMSSZ
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  }

  function icsEscape(s) {
    return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  }

  var start = parseEventStart();
  var btnsEl = document.getElementById('calBtns');
  var googleEl = document.getElementById('calGoogle');
  var icsEl = document.getElementById('calIcs');

  if (start && btnsEl && googleEl && icsEl) {
    var end = new Date(start.getTime() + EVENT_MINUTES * 60000);
    var joinLink = (params.get('wj_lead_unique_link_live_room') || '').trim();
    if (!/^https:\/\/[^\s]+$/.test(joinLink)) joinLink = '';

    var description = joinLink
      ? 'Your personal join link: ' + joinLink + '\nJoin from a desktop for the best experience.'
      : 'Your join link is in your registration email.\nJoin from a desktop for the best experience.';

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
