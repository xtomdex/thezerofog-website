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
