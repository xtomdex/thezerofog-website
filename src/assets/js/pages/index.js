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
    window.location.href = '/confirmation';
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
    '1': '(Without Caffeine Hacks, Productivity Apps, or Willpower)',
    '2': '(Without Supplements, Strict Routines, or Working Harder)',
    '3': '(Without Supplements, Productivity Apps, or Hustle)'
  };
  if (w && withouts[w]) {
    document.querySelector('.without-block').textContent = withouts[w];
  }
})();

// === COUNTDOWN TIMER (evergreen) ===
(function() {
  var key = 'zf_cd_end';
  var stored = localStorage.getItem(key);
  var end;
  var now = Date.now();

  if (stored && Number(stored) > now) {
    end = Number(stored);
  } else {
    var mins = 30 + Math.floor(Math.random() * 25);
    end = now + mins * 60 * 1000;
    localStorage.setItem(key, end);
  }

  function tick() {
    var diff = Math.max(0, end - Date.now());
    var h = Math.floor(diff / 3600000);
    var m = Math.floor((diff % 3600000) / 60000);
    var s = Math.floor((diff % 60000) / 1000);
    document.getElementById('cd-hrs').textContent = String(h).padStart(2, '0');
    document.getElementById('cd-min').textContent = String(m).padStart(2, '0');
    document.getElementById('cd-sec').textContent = String(s).padStart(2, '0');
    if (diff > 0) requestAnimationFrame(tick);
  }
  tick();
})();
