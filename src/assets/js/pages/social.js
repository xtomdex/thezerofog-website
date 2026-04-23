// === FORM HANDLER ===
document.getElementById('optinForm').addEventListener('submit', function(e) {
  e.preventDefault();
  var email = this.querySelector('input[type="email"]').value;

  // ====================================================
  // INTEGRATION POINT - Replace with your email service
  // ====================================================
  console.log('Email submitted:', email);

  // Redirect to thank you page
  window.location.href = 'thank-you.html';
});
