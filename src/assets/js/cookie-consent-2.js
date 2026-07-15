/* NETLIFY JS GUARD - DO NOT DELETE ------------------------------------------
 * This comment block intentionally pads the raw file so it stays longer than
 * any pretty-printed variant Netlify's asset pipeline may produce. The upload
 * pipeline has been observed to pretty-print assets and then overwrite them
 * with the original WITHOUT truncating, which corrupts the tail of any file
 * whose original is shorter than the pretty version. Netlify also dedupes
 * uploads by file sha, so this file must never be renamed without content
 * changes (and vice versa). See memory: css-cache-and-netlify-processing.
 * File renamed from cookie-consent.js -> cookie-consent-2.js on 2026-07-15
 * when the PostHog analytics loader was added below the consent logic.
 * -------------------------------------------------------------------------*/

// ZeroFog Cookie Consent Banner - storage key 'zf_cookies_consent' = 'all' | 'essential'
// Also the single consent-gated loader for ALL tracking: Meta Pixel (marketing)
// and PostHog (analytics + session replay). Nothing loads before consent === 'all'.
(function() {
  var STORAGE_KEY = 'zf_cookies_consent';
  var banner = document.getElementById('zf-cookie-banner');

  function show() { if (banner) banner.classList.add('zf-show'); }
  function hide() { if (banner) banner.classList.remove('zf-show'); }

  // Load marketing pixels (Meta Pixel). Called ONLY when consent === 'all'.
  // Idempotent and inert when no pixel ID is configured.
  function loadMarketingPixels() {
    // No pixel ID configured → nothing to load (site stays pixel-free).
    if (!window.ZF_META_PIXEL_ID) return;
    // Already loaded → never inject twice.
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

    window.zfPixelLoaded = true;
  }

  // Load PostHog (analytics + session replay). Called ONLY when consent === 'all'.
  // Idempotent and inert when no key is configured (site stays analytics-free).
  // We load array.js explicitly and init on load - no minified stub to maintain.
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
  // - checkout_clicked: #buyBtn on /sales/, .cta-checkout on /webinar-text/
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

  var replayPlayed = false;
  document.addEventListener('play', function(e) {
    if (replayPlayed) return;
    if (e.target && e.target.tagName === 'VIDEO' && location.pathname.indexOf('/replay') === 0) {
      replayPlayed = true;
      zfCapture('replay_video_started', { page: location.pathname });
    }
  }, true);

  // Read stored consent.
  var consent = null;
  try { consent = localStorage.getItem(STORAGE_KEY); } catch (e) {}

  // First visit (no choice yet) → show banner, load nothing.
  if (!consent) {
    setTimeout(show, 600);
  } else if (consent === 'all') {
    // Returning visitor who already consented → load now.
    loadTrackers();
  }

  // Public API
  window.zfSetConsent = function(value) {
    try { localStorage.setItem(STORAGE_KEY, value); } catch (e) {}
    hide();
    // Retroactive load in the same session (no reload needed) when consent is granted.
    if (value === 'all') loadTrackers();
  };

  window.zfShowCookieBanner = function() { show(); };

  window.zfClearConsent = function() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    show();
  };
})();
