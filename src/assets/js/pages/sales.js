// Enroll button → Stripe Checkout.
// Creates a Checkout Session server-side, then redirects to Stripe's hosted page.
(function() {
  var btn = document.getElementById('buyBtn');
  if (!btn) return;

  // Inline error element, inserted right after the button. We do not alter the
  // sales.njk markup, so the error node is created on demand here.
  var errorEl = null;
  function showError(msg) {
    if (!errorEl) {
      errorEl = document.createElement('p');
      errorEl.id = 'buyError';
      errorEl.style.cssText = 'color:#e5484d;font-size:0.85rem;text-align:center;margin-top:12px;';
      btn.parentNode.insertBefore(errorEl, btn.nextSibling);
    }
    errorEl.textContent = msg;
  }
  function clearError() {
    if (errorEl) errorEl.textContent = '';
  }

  btn.addEventListener('click', function(e) {
    e.preventDefault();

    var originalText = btn.textContent;
    clearError();
    btn.classList.add('is-loading');
    btn.setAttribute('aria-disabled', 'true');
    btn.style.pointerEvents = 'none';
    btn.textContent = 'Loading…';

    function restore() {
      btn.classList.remove('is-loading');
      btn.removeAttribute('aria-disabled');
      btn.style.pointerEvents = '';
      btn.textContent = originalText;
    }

    fetch('/.netlify/functions/create-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
      .then(function(res) {
        if (!res.ok) throw new Error('error');
        return res.json();
      })
      .then(function(data) {
        if (!data || !data.url) throw new Error('no url');
        // Redirect to Stripe's hosted checkout.
        window.location.href = data.url;
      })
      .catch(function() {
        restore();
        showError('Something went wrong, please try again.');
      });
  });
})();
