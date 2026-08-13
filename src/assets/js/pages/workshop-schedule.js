// Schedule step: ask the room which sessions are bookable, let the visitor pick one, register.
//
// Written in the same plain-ES5 style as index.js - this project ships no bundler and no
// framework, and a page this small does not need one.

(function () {
  var listEl = document.getElementById('slotList');
  var statusEl = document.getElementById('slotStatus');
  var formEl = document.getElementById('scheduleForm');
  var emailRow = document.getElementById('emailRow');
  var emailInput = document.getElementById('scheduleEmail');
  var consentEl = document.getElementById('scheduleConsent');
  var consentText = document.getElementById('consentText');
  var btn = document.getElementById('scheduleBtn');
  var errorEl = document.getElementById('scheduleError');
  var honeypot = document.getElementById('scheduleWebsite');

  var selected = null;

  // The browser knows its own timezone; the server refuses to guess one.
  var timeZone = 'UTC';
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (err) {}

  var storedEmail = '';
  try {
    storedEmail = sessionStorage.getItem('zf_workshop_email') || '';
  } catch (err) {}

  // Arriving here without having filled the form on the landing page is a normal path - a
  // bookmark, a shared link, a browser that blocks storage. Ask for the address instead of
  // sending them back.
  if (!storedEmail) {
    emailRow.hidden = false;
    emailInput.required = true;
  }

  // The button is NOT disabled while the form is incomplete, and that is deliberate.
  //
  // It used to be, and the result read as a broken page: a person picks a time, sees a greyed-out
  // "Save My Seat", and has no way to find out that the address and the consent box are what is
  // holding it. A control that refuses to work and will not say why is indistinguishable from one
  // that is simply broken.
  //
  // The email field and the consent box both carry `required`, so the browser itself names them
  // on submit, in the user's own language and next to the field at fault. The only condition it
  // cannot see is whether a time was picked, and that one we say ourselves.
  function updateButton() {
    if (selected) errorEl.textContent = '';
  }

  function renderSlots(data) {
    if (!data.open) {
      statusEl.textContent = 'Registration is closed at the moment.';
      return;
    }
    if (!data.slots || !data.slots.length) {
      statusEl.textContent = 'No times are open right now. Please check back shortly.';
      return;
    }

    statusEl.hidden = true;
    listEl.hidden = false;
    formEl.hidden = false;

    data.slots.forEach(function (slot, index) {
      var li = document.createElement('li');
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'slot' + (slot.urgent ? ' slot-urgent' : '');
      button.setAttribute('data-starts-at', slot.startsAt);
      button.setAttribute('data-kind', slot.kind);

      var main = document.createElement('span');
      main.className = 'slot-main';
      // The soonest session is described by how close it is, because "starts in 12 minutes"
      // is the thing that gets people to actually turn up.
      main.textContent =
        slot.urgent && slot.minutesAway <= 60
          ? 'Starts in ' + slot.minutesAway + ' minutes'
          : slot.label;

      var sub = document.createElement('span');
      sub.className = 'slot-sub';
      sub.textContent = slot.urgent && slot.minutesAway <= 60 ? slot.label : '';

      button.appendChild(main);
      if (sub.textContent) button.appendChild(sub);

      button.addEventListener('click', function () {
        var all = listEl.querySelectorAll('.slot');
        for (var i = 0; i < all.length; i++) all[i].classList.remove('slot-selected');
        button.classList.add('slot-selected');
        selected = { startsAt: slot.startsAt, kind: slot.kind };
        errorEl.textContent = '';
        updateButton();
      });

      li.appendChild(button);
      listEl.appendChild(li);

      // Preselect the soonest one. It is the default we want and it saves a click.
      if (index === 0) button.click();
    });
  }

  fetch('/.netlify/functions/wr-slots?tz=' + encodeURIComponent(timeZone))
    .then(function (res) {
      if (!res.ok) throw new Error('slots');
      return res.json();
    })
    .then(renderSlots)
    .catch(function () {
      statusEl.textContent = 'We could not load the times. Please refresh the page.';
    });

  consentEl.addEventListener('change', updateButton);
  emailInput.addEventListener('input', updateButton);

  formEl.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!selected) {
      errorEl.textContent = 'Pick a time first.';
      if (listEl.scrollIntoView) listEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    var email = storedEmail || emailInput.value;

    btn.disabled = true;
    btn.textContent = 'Saving your seat…';
    errorEl.textContent = '';

    var params = new URLSearchParams(window.location.search);
    var utm = {};
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(function (k) {
      var v = params.get(k);
      if (v) utm[k] = v;
    });

    fetch('/.netlify/functions/wr-register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email,
        startsAt: selected.startsAt,
        kind: selected.kind,
        tz: timeZone,
        consent: consentEl.checked,
        website: honeypot.value,
        utm: utm,
        source: 'schedule'
      })
    })
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, status: res.status, body: body };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          // 409 means the page went stale while it sat open - the slot they picked has
          // since passed. Reloading is genuinely the right fix, so say that rather than
          // showing a generic failure.
          if (result.status === 409) {
            errorEl.textContent =
              result.body.error || 'That time has passed. Please refresh and pick another.';
          } else {
            errorEl.textContent = result.body.error || 'Something went wrong, please try again.';
          }
          btn.disabled = false;
          btn.textContent = 'Save My Seat';
          return;
        }

        // The address stays in sessionStorage for one more page: /confirmation/ shows "we sent it
        // to X" and clears it there. Putting it in the redirect URL instead would leak it into
        // browser history and referrers.
        try {
          sessionStorage.setItem('zf_workshop_email', email);
        } catch (err) {}

        window.location.href = result.body.redirectUrl;
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = 'Save My Seat';
        errorEl.textContent = 'Something went wrong, please try again.';
      });
  });
})();
