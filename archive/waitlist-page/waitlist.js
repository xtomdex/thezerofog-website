// === FORM HANDLER (waitlist) ===
document.getElementById('optinForm').addEventListener('submit', function(e) {
  e.preventDefault();

  var form = this;
  var email = form.querySelector('input[name="email"]').value;
  var website = form.querySelector('input[name="website"]').value;
  var source = form.querySelector('input[name="source"]').value;
  var btn = document.getElementById('ctaBtn');
  var errorEl = document.getElementById('formError');

  errorEl.textContent = '';

  btn.disabled = true;
  btn.textContent = 'Saving…';

  fetch('/.netlify/functions/optin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, website: website, source: source })
  })
  .then(function(res) {
    if (!res.ok) throw new Error('error');
    window.location.href = '/waitlist-confirmed/';
  })
  .catch(function() {
    btn.disabled = false;
    btn.textContent = 'Join The Waitlist';
    errorEl.textContent = 'Something went wrong, please try again.';
  });
});
