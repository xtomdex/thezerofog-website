// Replay countdown - 48 hours from first visit
(function() {
  var key = 'zf_replay_end';
  var stored = localStorage.getItem(key);
  var end;
  var now = Date.now();

  if (stored && Number(stored) > now) {
    end = Number(stored);
  } else {
    end = now + 48 * 60 * 60 * 1000; // 48 hours
    localStorage.setItem(key, end);
  }

  function tick() {
    var diff = Math.max(0, end - Date.now());
    var h = Math.floor(diff / 3600000);
    var m = Math.floor((diff % 3600000) / 60000);
    var s = Math.floor((diff % 60000) / 1000);
    var el = document.getElementById('replayTimer');
    if (el) {
      el.textContent = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }
    if (diff > 0) requestAnimationFrame(tick);
    else {
      // Expired - show message
      el.textContent = 'Expired';
      el.style.color = 'var(--error)';
    }
  }
  tick();
})();
