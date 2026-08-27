// === FORM HANDLER ===
document.getElementById('optinForm').addEventListener('submit', function(e) {
  e.preventDefault();

  var form = this;
  var email = form.querySelector('input[name="email"]').value;
  var website = form.querySelector('input[name="website"]').value;
  var btn = document.getElementById('ctaBtn');
  var errorEl = document.getElementById('formError');

  errorEl.textContent = '';

  btn.disabled = true;
  btn.textContent = 'Saving your spot…';

  fetch('/.netlify/functions/optin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, website: website })
  })
  .then(function(res) {
    if (!res.ok) throw new Error('error');
    return res.json();
  })
  .then(function(data) {
    // Redirect to the schedule step returned by the function. If no redirectUrl is
    // present (e.g. honeypot path), treat it as a benign success and leave the button
    // in its submitted state — no error shown.
    if (!data || !data.redirectUrl) return;

    // Carry the address to the schedule step without putting it in the URL. A query
    // string would leave it in history, in referrers and in any analytics that records
    // paths. sessionStorage dies with the tab, which is exactly the lifetime we want.
    try {
      sessionStorage.setItem('zf_workshop_email', email);
    } catch (err) {
      // Private mode or a storage-blocked browser: the schedule step asks for the
      // address again rather than failing.
    }

    // Fire the Meta Pixel "Lead" event — best-effort, consent-gated. Only fires
    // when the pixel actually loaded (consent === 'all' + configured ID). If the
    // pixel is absent (essential/no consent/no ID), skip silently — never throw,
    // never block the redirect below. Fire-and-forget.
    if (window.zfPixelLoaded && typeof fbq === 'function') {
      fbq('track', 'Lead');
    }

    // Forward UTM params from the current landing-page URL to the schedule step for
    // attribution. Only the five standard utm_* keys are forwarded (never other
    // landing params like the A/B ?w=). The URL object merges with any query
    // params the target already carries instead of clobbering them.
    //
    // The second argument matters: the redirect target is now a same-site path, and
    // `new URL('/workshop/schedule/')` on its own throws — which would silently drop
    // every UTM param into the catch below.
    try {
      var landingParams = new URLSearchParams(window.location.search);
      var utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
      var target = new URL(data.redirectUrl, window.location.origin);
      utmKeys.forEach(function(key) {
        var value = landingParams.get(key);
        if (value) target.searchParams.set(key, value);
      });
      window.location.href = target.toString();
    } catch (err) {
      // If the redirect URL can't be parsed, don't block the redirect over UTMs.
      window.location.href = data.redirectUrl;
    }
  })
  .catch(function() {
    btn.disabled = false;
    btn.textContent = 'Save My Spot';
    errorEl.textContent = 'Something went wrong, please try again.';
  });
});

// === A/B TEST SUPPORT ===
(function() {
  var params = new URLSearchParams(window.location.search);
  var w = params.get('w');
  var withouts = {
    '1': '(Without Strict Routines, Productivity Apps, or Willpower)',
    '2': '(Without Supplements, Strict Routines, or Working Harder)',
    '3': '(Without Supplements, Productivity Apps, or Hustle)'
  };
  if (w && withouts[w]) {
    document.querySelector('.without-block').textContent = withouts[w];
  }
})();

/* === NEXT SESSION COUNTDOWN =============================================
   LIVE since 2026-08-27.

   Reads the nearest bookable session from wr-slots - the same endpoint the schedule
   step reads - and counts down to it. Nothing is hard-coded here: the schedule lives
   in wr-config, and a change there moves this line with it.

   Three traps this code is written around:

   1. The visitor's clock. A machine running a few minutes fast would see a countdown
      that is simply wrong, and one running slow would see a session it has already
      missed. The response's own `Date` header fixes the offset once, the same way the
      workshop room does it with serverNow().
   2. Zero. The JIT slot repeats every fifteen minutes, so the countdown WILL reach
      zero while somebody is still reading. It re-fetches instead of freezing on 00:00
      or, worse, counting into the negative.
   3. Silence. If the fetch fails, or the schedule is closed, or the next session is
      more than a day out, the line stays hidden. An urgency device that shows a stale
      or absurd number costs more trust than it buys.
   ======================================================================== */
(function () {
  var line = document.getElementById('nextSession');
  var clock = document.getElementById('nextSessionClock');
  if (!line || !clock || !window.fetch) return;

  var DAY_MS = 24 * 60 * 60 * 1000;
  var skewMs = 0;          // server clock minus this browser's clock
  var ticker = null;

  function serverNow() { return Date.now() + skewMs; }

  function pad(n) { return String(n).padStart(2, '0'); }

  function label(ms) {
    var left = Math.floor(ms / 1000);
    var h = Math.floor(left / 3600);
    var m = Math.floor((left % 3600) / 60);
    var s = left % 60;
    return (h > 0 ? h + ':' + pad(m) : pad(m)) + ':' + pad(s);
  }

  function start(startsAt) {
    var target = new Date(startsAt).getTime();
    if (isNaN(target)) return;

    if (ticker) clearInterval(ticker);

    function tick() {
      var left = target - serverNow();
      if (left > DAY_MS) { line.hidden = true; return; }
      if (left <= 0) {
        clearInterval(ticker);
        ticker = null;
        line.hidden = true;
        // The room opens on the quarter hour; give the server a moment to hand out
        // the next one rather than racing it.
        setTimeout(load, 5000);
        return;
      }
      clock.textContent = label(left);
      line.hidden = false;
    }

    tick();
    ticker = setInterval(tick, 1000);
  }

  function load() {
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}

    fetch('/.netlify/functions/wr-slots?tz=' + encodeURIComponent(tz))
      .then(function (res) {
        if (!res.ok) throw new Error('slots');
        var sent = res.headers.get('date');
        if (sent) {
          var t = new Date(sent).getTime();
          if (!isNaN(t)) skewMs = t - Date.now();
        }
        return res.json();
      })
      .then(function (data) {
        if (!data || !data.open || !data.slots || !data.slots.length) return;
        start(data.slots[0].startsAt);
      })
      .catch(function () { /* stay silent - see trap 3 */ });
  }

  load();
})();
