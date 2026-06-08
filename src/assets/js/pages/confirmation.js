// confirmation.js — runs on /confirmation/ after EverWebinar redirects post-registration.
// Two jobs: populate registrant details from wj_lead_* URL params, and reveal the
// correct device-strategy message (desktop vs mobile).
//
// SECURITY: wj_lead_* values come from the URL and are attacker-controllable. They
// MUST be injected via textContent only — never innerHTML / insertAdjacentHTML.

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
})();
