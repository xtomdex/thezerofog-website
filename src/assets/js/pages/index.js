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
    // Redirect to the EverWebinar schedule page returned by the function.
    // If no redirectUrl is present (e.g. honeypot path), treat it as a benign
    // success and leave the button in its submitted state — no error shown.
    if (data && data.redirectUrl) {
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
