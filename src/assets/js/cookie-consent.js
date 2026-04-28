// ZeroFog Cookie Consent Banner - storage key 'zf_cookies_consent' = 'all' | 'essential'
(function() {
  var STORAGE_KEY = 'zf_cookies_consent';
  var banner = document.getElementById('zf-cookie-banner');

  function show() { if (banner) banner.classList.add('zf-show'); }
  function hide() { if (banner) banner.classList.remove('zf-show'); }

  // Show on first visit
  var consent = null;
  try { consent = localStorage.getItem(STORAGE_KEY); } catch (e) {}
  if (!consent) { setTimeout(show, 600); }

  // Public API
  window.zfSetConsent = function(value) {
    try { localStorage.setItem(STORAGE_KEY, value); } catch (e) {}
    hide();
    // Pixel hook: when integrated, gate Meta/Google scripts on value === 'all'
  };

  window.zfShowCookieBanner = function() { show(); };

  window.zfClearConsent = function() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    show();
  };
})();
