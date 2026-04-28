// === COUNTDOWN (continues from opt-in via shared localStorage key) ===
(function() {
  var key = 'zf_cd_end';
  var stored = localStorage.getItem(key);
  var end;
  var now = Date.now();

  if (stored && Number(stored) > now) {
    end = Number(stored);
  } else {
    // Fallback if user landed here directly: ~25 min countdown
    end = now + 25 * 60 * 1000;
    localStorage.setItem(key, end);
  }

  function tick() {
    var diff = Math.max(0, end - Date.now());
    var h = Math.floor(diff / 3600000);
    var m = Math.floor((diff % 3600000) / 60000);
    var s = Math.floor((diff % 60000) / 1000);
    var hEl = document.getElementById('cd-hrs');
    var mEl = document.getElementById('cd-min');
    var sEl = document.getElementById('cd-sec');
    if (hEl) hEl.textContent = String(h).padStart(2, '0');
    if (mEl) mEl.textContent = String(m).padStart(2, '0');
    if (sEl) sEl.textContent = String(s).padStart(2, '0');
    if (diff > 0) requestAnimationFrame(tick);
  }
  tick();
})();
