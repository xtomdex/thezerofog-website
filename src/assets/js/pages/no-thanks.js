// The landing side of E13's one-click sales opt-out.
//
// The whole job: read the token, call wr-preferences, show one of three states. The call is
// made immediately - the click on the email link WAS the consent, so making the person click
// again here would be a second ask for something they already answered.

(function () {
  var token = new URLSearchParams(window.location.search).get('t');

  var working = document.getElementById('ntWorking');
  var done = document.getElementById('ntDone');
  var noToken = document.getElementById('ntNoToken');
  var error = document.getElementById('ntError');

  function show(el) {
    working.hidden = true;
    done.hidden = true;
    noToken.hidden = true;
    error.hidden = true;
    el.hidden = false;
  }

  if (!token) {
    show(noToken);
    return;
  }

  fetch('/.netlify/functions/wr-preferences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: token }),
  })
    .then(function (r) {
      if (!r.ok) throw new Error('status ' + r.status);
      return r.json();
    })
    .then(function () {
      show(done);
    })
    .catch(function () {
      show(error);
    });
})();
