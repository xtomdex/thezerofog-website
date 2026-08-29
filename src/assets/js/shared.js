// === THE ZEROFOG - SHARED JS ===

// Theme toggle (button click)
function toggleTheme() {
  document.documentElement.classList.toggle('dark');
  var isDark = document.documentElement.classList.contains('dark');
  document.getElementById('themeToggle').textContent = isDark ? 'Light' : 'Dark';
  localStorage.setItem('zf_theme', isDark ? 'dark' : 'light');
}

// On DOM ready: sync toggle button text to whatever theme is active
// (initial theme class is set by inline script in <head> before paint - see base.njk)
(function() {
  var btn = document.getElementById('themeToggle');
  if (!btn) return;
  var isDark = document.documentElement.classList.contains('dark');
  btn.textContent = isDark ? 'Light' : 'Dark';
})();

// Listen for OS theme changes when user has not explicitly chosen via toggle
(function() {
  if (!window.matchMedia) return;
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  if (!mq.addEventListener) return;
  mq.addEventListener('change', function(e) {
    if (localStorage.getItem('zf_theme')) return; // user has explicit choice, respect it
    if (e.matches) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    var btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = e.matches ? 'Light' : 'Dark';
  });
})();

// === ATTRIBUTION TOUCH LOG (first-party, decided 2026-08-29) ===
// Every page beacons one pageview to our own /touch function; email inputs beacon a
// browser-computed SHA-256 hash on blur (the raw address of someone who never submits
// never leaves the browser). Server pairs each touch with a salted IP hash - the seam
// that stitches a phone's ad click to a desktop opt-in two minutes later. Best-effort:
// nothing here may ever block or break a page.
(function () {
  function send(payload) {
    try {
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/.netlify/functions/touch', new Blob([body], { type: 'application/json' }));
      } else {
        fetch('/.netlify/functions/touch', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: body, keepalive: true
        }).catch(function () {});
      }
    } catch (e) { /* never surface */ }
  }

  function phIds() {
    try {
      if (window.posthog && window.posthog.get_distinct_id) {
        return {
          id: window.posthog.get_distinct_id(),
          sid: window.posthog.get_session_id ? window.posthog.get_session_id() : null
        };
      }
    } catch (e) { /* consent refused or not loaded yet */ }
    return null;
  }

  // Pageview. Delayed a beat so a consent-approved PostHog has had time to init and the
  // touch can carry its ids; the touch itself does not depend on consent (hashed,
  // first-party - see the privacy page).
  setTimeout(function () {
    send({ kind: 'pageview', url: location.href, ref: document.referrer || null, ph: phIds() });
  }, 2500);

  // Pre-submit email capture: hash in the browser, beacon the hash only.
  function hashAndSend(value) {
    var email = String(value || '').trim().toLowerCase();
    if (!email || email.indexOf('@') < 1 || !window.crypto || !window.crypto.subtle) return;
    try {
      window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(email)).then(function (buf) {
        var hex = Array.prototype.map.call(new Uint8Array(buf), function (b) {
          return ('0' + b.toString(16)).slice(-2);
        }).join('');
        send({ kind: 'email_field', url: location.href, emailHash: hex, ph: phIds() });
      }).catch(function () {});
    } catch (e) { /* never surface */ }
  }

  document.addEventListener('blur', function (e) {
    var t = e.target;
    if (t && t.tagName === 'INPUT' && (t.type === 'email' || t.autocomplete === 'email')) {
      hashAndSend(t.value);
    }
  }, true);
})();
