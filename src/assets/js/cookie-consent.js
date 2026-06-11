// ZeroFog Cookie Consent Banner - storage key 'zf_cookies_consent' = 'all' | 'essential'
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

  // Read stored consent.
  var consent = null;
  try { consent = localStorage.getItem(STORAGE_KEY); } catch (e) {}

  // First visit (no choice yet) → show banner, load nothing.
  if (!consent) {
    setTimeout(show, 600);
  } else if (consent === 'all') {
    // Returning visitor who already consented to marketing → load now.
    loadMarketingPixels();
  }

  // Public API
  window.zfSetConsent = function(value) {
    try { localStorage.setItem(STORAGE_KEY, value); } catch (e) {}
    hide();
    // Retroactive load in the same session (no reload needed) when consent is granted.
    if (value === 'all') loadMarketingPixels();
  };

  window.zfShowCookieBanner = function() { show(); };

  window.zfClearConsent = function() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    show();
  };
})();
