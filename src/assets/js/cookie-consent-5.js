/* NETLIFY JS GUARD - DO NOT DELETE ------------------------------------------
 * This comment block intentionally pads the raw file so it stays longer than
 * any pretty-printed variant Netlify's asset pipeline may produce. The upload
 * pipeline has been observed to pretty-print assets and then overwrite them
 * with the original WITHOUT truncating, which corrupts the tail of any file
 * whose original is shorter than the pretty version. Netlify also dedupes
 * uploads by file sha, so this file must never be renamed without content
 * changes (and vice versa). See memory: css-cache-and-netlify-processing.
 * v3 (2026-07-15): geo-split consent regimes. EU/EEA/UK/CH = opt-in (nothing
 * loads before "Accept All"); everywhere else = opt-out (trackers load by
 * default, one-click "Opt out"). Decision + rationale: memory file
 * project_cookie_consent_policy.md - reject stays ONE CLICK in both regimes,
 * no dark patterns (AEPD/CNIL fine exactly that; AEPD is our home regulator).
 * v4 (2026-07-15): dismiss UX. Prominent X = close without choosing (per
 * session, sessionStorage) - closing is NOT consent and NOT refusal: opt-in
 * keeps not loading, opt-out keeps running. Opt-out banner also auto-hides
 * on first real scroll (it is a notice, not a consent gate); footer
 * "Cookie Settings" reopens it anytime.
 * v5 (2026-07-15): consent stored in a Domain=.thezerofog.com cookie (1y,
 * SameSite=Lax, Secure) so subdomains (platform.thezerofog.com) can read the
 * choice too. localStorage kept as write-through fallback + one-time
 * migration source for visitors who chose under v1-v4. The consent cookie
 * itself is strictly-necessary (stores the choice) - no consent needed to
 * set it. Domain attribute is only used on *.thezerofog.com hosts so local
 * dev keeps working.
 * -------------------------------------------------------------------------*/

// ZeroFog Cookie Consent - storage key 'zf_cookies_consent' = 'all' | 'essential'
// Single consent-gated loader for ALL tracking: Meta Pixel (marketing) and
// PostHog (analytics + session replay).
//
// Consent regimes (decided by /geo edge function, cached per browser session):
//   opt-in  (EU/EEA/UK/CH or unknown): load NOTHING until "Accept All".
//   opt-out (everywhere else):         load immediately, banner offers opt out.
// A stored choice always wins over the regime - both regimes write the same
// 'all' / 'essential' value and are respected on every later visit.
(function() {
  var STORAGE_KEY = 'zf_cookies_consent';
  var REGIME_CACHE_KEY = 'zf_cookies_regime';
  var DISMISS_KEY = 'zf_cookies_dismissed';

  // Consent choice lives in a domain-wide cookie so platform.thezerofog.com
  // (Systeme, different origin - localStorage does NOT cross) sees it too.
  function readConsentCookie() {
    var m = document.cookie.match(/(?:^|;\s*)zf_cookies_consent=(all|essential)(?:;|$)/);
    return m ? m[1] : null;
  }

  function writeConsentCookie(value) {
    try {
      var attrs = '; Path=/; Max-Age=31536000; SameSite=Lax';
      if (/(^|\.)thezerofog\.com$/.test(location.hostname)) {
        attrs += '; Domain=.thezerofog.com; Secure';
      }
      document.cookie = 'zf_cookies_consent=' + value + attrs;
    } catch (e) {}
  }

  // Cookie first (domain-wide truth), localStorage as fallback for choices
  // made under v1-v4 - migrated into the cookie on first read.
  function readStoredConsent() {
    var v = readConsentCookie();
    if (v) return v;
    try { v = localStorage.getItem(STORAGE_KEY); } catch (e) {}
    if (v === 'all' || v === 'essential') { writeConsentCookie(v); return v; }
    return null;
  }
  var banner = document.getElementById('zf-cookie-banner');

  // GDPR-family jurisdictions -> opt-in regime. EU-27 + EEA (IS, LI, NO) +
  // UK (UK GDPR) + CH (revFADP). Everything else (incl. our US target market,
  // where CCPA is an opt-OUT regime) gets the opt-out banner.
  var OPT_IN_COUNTRIES = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR',
    'DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK',
    'SI','ES','SE','IS','LI','NO','GB','CH'];

  function show() { if (banner) banner.classList.add('zf-show'); }
  function hide() { if (banner) banner.classList.remove('zf-show'); }

  // Close without choosing: remembered for this browser session only. Not
  // consent and not refusal - opt-in stays untracked, opt-out stays tracked.
  function dismiss() {
    try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch (e) {}
    hide();
  }

  // Opt-out regime only: the banner is a notice, not a consent gate - tuck it
  // away once the visitor starts reading (first real scroll).
  function armScrollHide() {
    var startY = window.scrollY;
    function onScroll() {
      if (Math.abs(window.scrollY - startY) > 200) {
        window.removeEventListener('scroll', onScroll);
        if (banner && banner.classList.contains('zf-show')) dismiss();
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  function setMode(mode) {
    if (!banner) return;
    banner.classList.remove('zf-mode-optin', 'zf-mode-optout');
    banner.classList.add(mode === 'optout' ? 'zf-mode-optout' : 'zf-mode-optin');
  }

  // Value and currency come from env (EXPECTED_AMOUNT_TOTAL / EXPECTED_CURRENCY), the same pair
  // stripe-webhook.js validates the order against, so the reported number cannot drift from the
  // accepted one. Unset means we report the sale with no value rather than a made-up one: a
  // wrong price teaches the delivery system to chase the wrong customers.
  function purchaseParams() {
    if (!window.ZF_PURCHASE_VALUE) return {};
    return {
      value: Number(window.ZF_PURCHASE_VALUE),
      currency: window.ZF_PURCHASE_CURRENCY || 'USD',
    };
  }

  // Load marketing pixels (Meta Pixel). Idempotent, inert when no ID configured.
  function loadMarketingPixels() {
    if (!window.ZF_META_PIXEL_ID) return;
    if (window.zfPixelLoaded) return;

    // Standard Meta Pixel bootstrap.
    !function(f,b,e,v,n,t,s)
    {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};
    if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
    n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t,s)}(window, document,'script',
    'https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', window.ZF_META_PIXEL_ID);
    fbq('track', 'PageView');

    // Purchase. Stripe sends buyers to /welcome/?session_id=... (create-checkout.js success_url),
    // so this is the only place in the browser where a completed sale is observable. Without it
    // the account measures traffic and leads and no revenue at all, which is what optimisation
    // actually needs. Sits beside the PostHog `purchase_landed` below, on the same condition.
    //
    // eventID is the Stripe checkout session id, and it is the whole point: stripe-webhook.js
    // already holds the same id server-side, so when the Conversions API lands it can send the
    // same event with the same id and Meta will collapse the pair instead of counting two sales.
    //
    // Guarded against a reload: the browser event is fire-and-forget and a refresh of the success
    // page would otherwise book a second purchase. sessionStorage, not localStorage - a genuine
    // second purchase later gets a different session id anyway, and this keeps the key from
    // living forever.
    var sid = (location.search.match(/[?&]session_id=([^&]+)/) || [])[1];
    if (sid && location.pathname.indexOf('/welcome') === 0) {
      var seen = 'zf_fb_purchase_' + sid;
      try {
        if (!sessionStorage.getItem(seen)) {
          sessionStorage.setItem(seen, '1');
          fbq('track', 'Purchase', purchaseParams(), { eventID: decodeURIComponent(sid) });
        }
      } catch (e) {
        // Private mode can refuse sessionStorage. Losing the guard is better than losing the sale.
        fbq('track', 'Purchase', purchaseParams(), { eventID: decodeURIComponent(sid) });
      }
    }

    window.zfPixelLoaded = true;
  }

  // Load PostHog (analytics + session replay). Idempotent, inert when no key.
  function loadPostHog() {
    if (!window.ZF_POSTHOG_KEY) return;
    if (window.zfPosthogLoaded) return;
    window.zfPosthogLoaded = true;

    var host = window.ZF_POSTHOG_HOST || 'https://us.i.posthog.com';
    var s = document.createElement('script');
    s.async = true;
    s.src = host.replace('.i.posthog.com', '-assets.i.posthog.com') + '/static/array.js';
    s.onload = function() {
      if (!window.posthog || !window.posthog.init) return;
      window.posthog.init(window.ZF_POSTHOG_KEY, {
        api_host: host,
        // Autocapture (clicks/forms) on; typed input VALUES are never autocaptured.
        autocapture: true,
        capture_pageview: true,
        capture_pageleave: true,
        persistence: 'localStorage+cookie',
        // Session replay: mask everything the user types (emails etc.).
        session_recording: { maskAllInputs: true }
      });
      // Funnel step: Stripe redirects here after payment (see create-checkout.js
      // success_url = /welcome/?session_id=...). Fires only on real purchases.
      if (location.pathname.indexOf('/welcome') === 0 &&
          location.search.indexOf('session_id=') !== -1) {
        window.posthog.capture('purchase_landed');
      }
    };
    document.head.appendChild(s);
  }

  // All consent-gated trackers. Single entry point so future additions gate here.
  function loadTrackers() {
    loadMarketingPixels();
    loadPostHog();
  }

  // Best-effort stop for the opt-out path: trackers may already be running in
  // this session (opt-out regime loads them before the choice). Stops capture
  // and recording immediately; the stored 'essential' keeps every future page
  // load tracker-free.
  function stopTrackers() {
    try {
      if (window.posthog && window.posthog.opt_out_capturing) {
        window.posthog.opt_out_capturing();
        if (window.posthog.stopSessionRecording) window.posthog.stopSessionRecording();
      }
    } catch (e) {}
    try {
      if (window.fbq) fbq('consent', 'revoke');
    } catch (e) {}
  }

  // Safe capture: no-ops until PostHog is consented + loaded.
  function zfCapture(name, props) {
    if (window.posthog && window.posthog.capture) {
      // sendBeacon: these events fire right before navigation (redirect to
      // EverWebinar / Stripe), a normal XHR would be killed by the unload.
      window.posthog.capture(name, props, { transport: 'sendBeacon' });
    }
  }

  // Custom funnel events, delegated so page scripts stay untouched:
  // - optin_submitted: landing form #optinForm (fires before the EverWebinar redirect)
  // - checkout_clicked: #buyBtn on /sales/, .cta-checkout on /workshop-text/
  // - replay_video_started: first <video> play on /replay/ (no-op until embedded)
  document.addEventListener('submit', function(e) {
    if (e.target && e.target.id === 'optinForm') {
      zfCapture('optin_submitted', { page: location.pathname });
    }
  }, true);

  document.addEventListener('click', function(e) {
    var t = e.target && e.target.closest ? e.target.closest('#buyBtn, .cta-checkout') : null;
    if (t) zfCapture('checkout_clicked', { page: location.pathname });
  }, true);

  /* Engaged40 - the pixel-warming event. LIVE 2026-08-27.
     ---------------------------------------------------------------------------
     WHY IT EXISTS. The leads objective was tried on 23.08 and died: the ad set was
     told to buy `fb_pixel_lead`, an event this pixel had never once fired, so Meta
     had nothing to look for and stopped delivering - 27 impressions in eight hours.
     Optimisation needs a signal that actually happens. This is that signal: it says
     "somebody stayed on the landing page for forty seconds", it fires dozens of
     times a day, and it is meant to be REPLACED by the real Lead event once opt-ins
     exist. It is scaffolding, not a metric - never report it as a result.

     WHICH FORTY SECONDS. Measured 27.08 over four days of ad traffic, n=1095:
     forty seconds of wall-clock reaches 280 sessions, forty seconds of PostHog
     `active_seconds` reaches ONE. The two clocks differ by a factor of 280, so the
     clock has to be named. This counts VISIBLE wall-clock time: a tab in the
     background accumulates nothing, which is the one correction that keeps this
     from counting parked tabs, but it does not pretend to measure attention.

     WHY THE RETRY. Under the opt-in regime (EU/UK/CH) the pixel may not exist yet
     at second forty - the visitor can accept cookies afterwards. The timer runs
     regardless and the send waits for the pixel, up to thirty seconds. US traffic,
     which is all our ads buy today, is opt-out and has the pixel from the first
     frame. */
  (function () {
    if (location.pathname !== '/') return;

    var THRESHOLD_MS = 40000;
    var TICK_MS = 1000;
    var visibleMs = 0;
    var last = Date.now();

    /* Time alone is not enough. A tab left open in another window accumulates
       visible seconds and tells Meta nothing about a person, and an audience
       learned from parked tabs is no better than one learned from reflex
       tappers - which is the whole reason we left the click objective.
       So the event also requires that the visitor did SOMETHING here.
       Measured 27.08 over four days of ad traffic, n=1095, per week:
           40s alone .................... 490 events
           40s AND one interaction ...... 147 events   <- this rule
           40s AND 8s of activity ........ 21 events   (under Meta's ~50 floor)
       The middle rule throws out parked tabs and still clears the floor
       threefold. */
    var interacted = false;
    var MARKS = ['scroll', 'pointerdown', 'touchstart', 'keydown', 'click'];
    function mark() {
      interacted = true;
      for (var j = 0; j < MARKS.length; j++) {
        window.removeEventListener(MARKS[j], mark, true);
      }
    }
    for (var k = 0; k < MARKS.length; k++) {
      window.addEventListener(MARKS[k], mark, { capture: true, passive: true });
    }

    /* Count elapsed TIME, not ticks. Chrome throttles setInterval in a
       backgrounded tab to roughly once a minute, so a tick counter reads forty
       seconds as forty minutes there - measured 27.08, forty-four real seconds
       produced no tick at all. Clamping each step to twice the tick size keeps
       the opposite error out too: a laptop that slept for an hour must not wake
       up and call it an hour of reading. */
    var iv = setInterval(function () {
      var now = Date.now();
      var step = now - last;
      last = now;
      if (document.visibilityState !== 'visible') return;
      visibleMs += Math.min(step, TICK_MS * 2);
      // Both conditions, whichever lands last: a fast scroller still has to stay,
      // and a long starer still has to touch the page.
      if (visibleMs < THRESHOLD_MS || !interacted) return;
      clearInterval(iv);
      zfCapture('engaged_40s', { page: location.pathname });
      var tries = 0;
      (function push() {
        if (window.zfPixelLoaded && typeof fbq === 'function') {
          // ViewContent is the one an ad set can be pointed at directly
          // (promoted_object.custom_event_type = VIEW_CONTENT). It fires nowhere
          // else on this site, so it means exactly one thing: read the landing
          // page for forty seconds. Engaged40 goes out beside it so a named
          // custom conversion can be built in Events Manager later without
          // another deploy - it is not what the ad set buys.
          fbq('track', 'ViewContent');
          fbq('trackCustom', 'Engaged40');
          return;
        }
        if (++tries > 15) return;
        setTimeout(push, 2000);
      })();
    }, TICK_MS);
  })();

  var replayPlayed = false;
  document.addEventListener('play', function(e) {
    if (replayPlayed) return;
    if (e.target && e.target.tagName === 'VIDEO' && location.pathname.indexOf('/replay') === 0) {
      replayPlayed = true;
      zfCapture('replay_video_started', { page: location.pathname });
    }
  }, true);

  // Resolve the consent regime: 'optin' | 'optout'.
  // Order: ?zfgeo=XX test override -> sessionStorage cache -> /geo edge lookup.
  // Any failure or unknown country falls back to 'optin' (the safe regime).
  function resolveRegime(cb) {
    var m = location.search.match(/[?&]zfgeo=([A-Za-z]{2})/);
    if (m) { cb(regimeFor(m[1].toUpperCase())); return; }

    var cached = null;
    try { cached = sessionStorage.getItem(REGIME_CACHE_KEY); } catch (e) {}
    if (cached === 'optin' || cached === 'optout') { cb(cached); return; }

    fetch('/geo').then(function(r) { return r.json(); }).then(function(data) {
      var regime = regimeFor(data && data.country);
      try { sessionStorage.setItem(REGIME_CACHE_KEY, regime); } catch (e) {}
      cb(regime);
    }).catch(function() { cb('optin'); });
  }

  function regimeFor(country) {
    if (!country) return 'optin';
    return OPT_IN_COUNTRIES.indexOf(country) !== -1 ? 'optin' : 'optout';
  }

  // Read stored consent (cookie-first, with localStorage migration).
  var consent = readStoredConsent();

  if (consent === 'all') {
    // Returning visitor who already consented -> load, no banner.
    loadTrackers();
  } else if (consent === 'essential') {
    // Returning visitor who declined -> nothing, no banner.
  } else {
    // First visit: regime decides whether trackers wait for consent.
    resolveRegime(function(regime) {
      if (regime === 'optout') loadTrackers();
      var dismissed = null;
      try { dismissed = sessionStorage.getItem(DISMISS_KEY); } catch (e) {}
      if (dismissed) return; // closed via X or scroll earlier this session
      setMode(regime);
      setTimeout(show, 600);
      if (regime === 'optout') armScrollHide();
    });
  }

  // Public API
  window.zfSetConsent = function(value) {
    writeConsentCookie(value);
    try { localStorage.setItem(STORAGE_KEY, value); } catch (e) {}
    hide();
    if (value === 'all') loadTrackers();
    if (value === 'essential') stopTrackers();
  };

  window.zfDismissBanner = function() { dismiss(); };

  window.zfShowCookieBanner = function() {
    resolveRegime(function(regime) {
      setMode(regime);
      show();
    });
  };

  window.zfClearConsent = function() {
    try {
      var attrs = '; Path=/; Max-Age=0; SameSite=Lax';
      document.cookie = 'zf_cookies_consent=' + attrs;
      if (/(^|\.)thezerofog\.com$/.test(location.hostname)) {
        document.cookie = 'zf_cookies_consent=' + attrs + '; Domain=.thezerofog.com; Secure';
      }
    } catch (e) {}
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    window.zfShowCookieBanner();
  };
})();
