// The room player.
//
// The page renders nothing until the server has told it what state the session is in. Every
// decision that matters - is it running, where is the playhead, may this person seek, which
// timed elements exist, is the replay still open - is made in wr-room.js. This file draws it.
//
// Two things here are load-bearing and easy to get subtly wrong:
//
// 1. Watched seconds are accumulated from `timeupdate` DELTAS, never read off `currentTime`.
//    Reading currentTime would let someone drag the scrubber past the reveal on the replay and
//    be credited with having watched it - and the emails that name the mechanism and the price
//    hang off exactly that number.
// 2. The playhead follows the SERVER clock, not the browser's. A tab that was backgrounded, a
//    laptop that slept, a machine whose clock is twenty minutes out - all of them would drift
//    out of the session otherwise.

(function () {
  // Once a minute, not once every twenty seconds.
  //
  // The interval does NOT set the accuracy of the watched-seconds figure - that is accumulated
  // in the page and sent as a running total, so a slower beat sends the same number later. What
  // it does set is how many serverless invocations one viewer costs: a 90-minute session at 20s
  // is 270 calls per person, which at a few hundred attendees a month is most of a hosting tier
  // spent on bookkeeping. At 60s it is 90, and the exit beacon still captures the final state.
  var HEARTBEAT_MS = 60000;
  var DRIFT_TOLERANCE_SEC = 3;
  var MAX_TIMEUPDATE_DELTA_SEC = 2; // a bigger jump is a seek or a buffer skip, not watching

  var root = document.getElementById('room');
  if (!root) return;

  var token = new URLSearchParams(window.location.search).get('t');

  var els = {
    status: document.getElementById('roomStatus'),
    stage: document.getElementById('roomStage'),
    video: document.getElementById('roomVideo'),
    joinBtn: document.getElementById('roomJoin'),
    countdown: document.getElementById('roomCountdown'),
    notice: document.getElementById('roomNotice'),
    offer: document.getElementById('roomOffer'),
    offerBtn: document.getElementById('roomOfferBtn'),
    offerHeadline: document.getElementById('roomOfferHeadline'),
    sticky: document.getElementById('roomSticky'),
    handouts: document.getElementById('roomHandouts'),
    expiry: document.getElementById('roomExpiry'),
    questionForm: document.getElementById('roomQuestionForm'),
    questionInput: document.getElementById('roomQuestion'),
    questionNote: document.getElementById('roomQuestionNote')
  };

  var state = null;
  var phase = 'live';
  var watchedSec = 0;
  var lastTime = null;
  var serverSkewMs = 0; // serverNow - browser now
  var shownElements = {};
  var ended = false;

  function say(text) {
    els.status.hidden = false;
    els.status.textContent = text;
  }

  function serverNow() {
    return Date.now() + serverSkewMs;
  }

  function livePosition() {
    return (serverNow() - new Date(state.startsAt).getTime()) / 1000;
  }

  function beat(event, payload) {
    if (!token) return;
    var body = JSON.stringify({
      t: token,
      positionSec: Math.floor(els.video.currentTime || 0),
      watchedSec: Math.floor(watchedSec),
      phase: phase,
      event: event || 'heartbeat',
      payload: payload || null
    });

    // On the way out the page is being torn down and fetch will be cancelled; sendBeacon is the
    // only thing that survives. Same pattern the consent script already uses before a redirect.
    //
    // `offer_click` is in this branch for the same reason as `exit` and not as an afterthought:
    // the offer button is an ordinary link, so the click and the navigation to /sales happen in
    // the same tick. A plain fetch would be cancelled by the navigation and we would lose the
    // single hottest signal in the room - precisely on the people who reached for the price.
    if ((event === 'exit' || event === 'offer_click') && navigator.sendBeacon) {
      navigator.sendBeacon('/.netlify/functions/wr-heartbeat', new Blob([body], { type: 'application/json' }));
      return;
    }

    fetch('/.netlify/functions/wr-heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      keepalive: true
    }).catch(function () {
      // A dropped heartbeat is not worth interrupting anyone's session over. The next one
      // carries the same cumulative number, so nothing is lost unless every single one fails.
    });
  }

  function showOffer() {
    if (shownElements.offer || !state.elements || !state.elements.offer) return;
    shownElements.offer = true;
    var offer = state.elements.offer;
    els.offerHeadline.textContent = offer.headline || '';
    els.offerBtn.textContent = offer.buttonLabel || 'Get started';
    els.offerBtn.href = offer.url;
    els.offer.hidden = false;
    beat('offer_shown');
  }

  // Reaching for the price is an act, and until now only the SHOWING of the offer was recorded.
  // `offer_click` was already an allowed event type on the server and in the schema - the button
  // simply was never wired to it, so we knew who saw the price and not who moved toward it.
  //
  // Bound once at load rather than inside showOffer(): the same button is also revealed on the
  // expired-session branch, which never calls showOffer at all.
  els.offerBtn.addEventListener('click', function () {
    beat('offer_click', { phase: phase, href: els.offerBtn.getAttribute('href') });
  });

  function showHandout(item) {
    if (shownElements['handout:' + item.url]) return;
    shownElements['handout:' + item.url] = true;
    var a = document.createElement('a');
    a.href = item.url;
    a.className = 'room-handout';
    a.textContent = item.label;
    a.target = '_blank';
    a.rel = 'noopener';
    a.addEventListener('click', function () {
      beat('handout_click', { url: item.url });
    });
    els.handouts.appendChild(a);
    els.handouts.hidden = false;
  }

  function showAnnouncement(item) {
    if (shownElements['ann:' + item.atSec]) return;
    shownElements['ann:' + item.atSec] = true;
    els.notice.textContent = item.text;
    els.notice.hidden = false;
    beat('announcement_shown', { atSec: item.atSec });
  }

  function applyTimedElements(position) {
    var e = state.elements;
    if (!e) return;

    if (e.offer && position >= e.offer.atSec) showOffer();

    (e.handouts || []).forEach(function (h) {
      if (position >= h.atSec) showHandout(h);
    });

    (e.announcements || []).forEach(function (a) {
      if (position >= a.atSec) showAnnouncement(a);
    });
  }

  function onTimeUpdate() {
    var now = els.video.currentTime;

    if (lastTime !== null) {
      var delta = now - lastTime;
      // Only forward movement at roughly real speed counts. A jump means a seek or a buffer
      // skip, and neither is watching.
      if (delta > 0 && delta <= MAX_TIMEUPDATE_DELTA_SEC) watchedSec += delta;
    }
    lastTime = now;

    applyTimedElements(now);

    // Keep the playhead pinned to the session clock. Small corrections only - resetting
    // currentTime is visible to the viewer, so it is done when the drift is real, not
    // whenever a fraction of a second appears.
    if (phase === 'live' && !ended) {
      var target = livePosition();
      if (target >= state.durationSec) {
        finish();
        return;
      }
      if (Math.abs(target - now) > DRIFT_TOLERANCE_SEC) {
        els.video.currentTime = target;
        lastTime = target;
      }
    }
  }

  function finish() {
    if (ended) return;
    ended = true;
    beat('exit');
    if (state.endRedirect) window.location.href = state.endRedirect;
  }

  function startPlayback(position) {
    els.video.src = state.videoUrl;
    if (state.posterUrl) els.video.poster = state.posterUrl;

    // Captions. The master has them embedded as a mov_text track, which no browser will render,
    // so they are served separately as WebVTT and attached here. Default on: most of this
    // audience watches with the sound down at least part of the time.
    if (state.captionsUrl) {
      var track = document.createElement('track');
      track.kind = 'captions';
      track.label = 'English';
      track.srclang = 'en';
      track.src = state.captionsUrl;
      track.default = true;
      els.video.appendChild(track);
    }

    els.video.addEventListener('loadedmetadata', function () {
      els.video.currentTime = Math.max(0, position);
      lastTime = els.video.currentTime;
      els.video.play().catch(function () {
        // Autoplay was refused even after the click. Surface it rather than showing a
        // silent black rectangle.
        say('Press play to start.');
        els.video.controls = true;
      });
    });

    els.video.addEventListener('timeupdate', onTimeUpdate);
    els.video.addEventListener('ended', finish);

    // No seek bar is rendered, but a keyboard or a media key can still move the playhead
    // during the session. Snap it back.
    els.video.addEventListener('seeking', function () {
      if (state.allowSeek || phase === 'replay') return;
      var target = livePosition();
      if (Math.abs(els.video.currentTime - target) > DRIFT_TOLERANCE_SEC) {
        els.video.currentTime = target;
      }
    });

  }

  // The room's own pulse, deliberately NOT inside startPlayback().
  //
  // It used to live there, and the consequence was that someone who opened the room and never
  // pressed Join sent exactly one signal in their whole visit - the initial wr-room request.
  // After that, silence: no heartbeat, no exit. We could not tell a person sitting in front of
  // an unplayed session from one who closed the tab ten seconds in, and both were filed as
  // no-shows. Everything that reacts to "here but not watching" needs this pulse to exist
  // before the video does.
  //
  // `watchedSec` stays at zero until playback actually moves the playhead, so a beat sent from
  // an idle room cannot inflate anyone's watch time or move them a segment.
  var lifecycleBound = false;
  function bindLifecycle() {
    if (lifecycleBound) return;
    lifecycleBound = true;

    setInterval(function () {
      if (!ended) beat('heartbeat');
    }, HEARTBEAT_MS);

    window.addEventListener('pagehide', function () {
      beat('exit');
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') beat('heartbeat');
    });
  }

  function renderCountdown() {
    function tick() {
      var left = Math.round((new Date(state.startsAt).getTime() - serverNow()) / 1000);
      if (left <= 0) {
        window.location.reload();
        return;
      }
      var h = Math.floor(left / 3600);
      var m = Math.floor((left % 3600) / 60);
      var s = left % 60;
      els.countdown.textContent =
        (h > 0 ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }
    tick();
    setInterval(tick, 1000);
    els.countdown.hidden = false;
  }

  function renderExpiry() {
    function tick() {
      var left = Math.round((new Date(state.expiresAt).getTime() - serverNow()) / 1000);
      if (left <= 0) {
        window.location.reload();
        return;
      }
      var h = Math.floor(left / 3600);
      var m = Math.floor((left % 3600) / 60);
      var s = left % 60;
      els.expiry.textContent =
        String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }
    tick();
    setInterval(tick, 1000);
  }

  function render() {
    serverSkewMs = new Date(state.serverNow).getTime() - Date.now();

    if (state.state === 'early') {
      say('Your session has not started yet.');
      renderCountdown();
      return;
    }

    if (state.state === 'expired') {
      say('This session has finished and the replay window has closed.');
      if (state.offerUrl) {
        els.offerBtn.href = state.offerUrl;
        els.offerBtn.textContent = 'See the program';
        els.offerHeadline.textContent = '';
        els.offer.hidden = false;
      }
      return;
    }

    if (state.state === 'replay-redirect') {
      window.location.href = state.redirectUrl;
      return;
    }

    phase = state.state === 'replay' ? 'replay' : 'live';

    if (phase === 'replay') {
      els.video.controls = state.allowSeek !== false;
      if (els.expiry) {
        document.getElementById('roomExpiryBar').hidden = false;
        renderExpiry();
      }
    } else if (state.lateJoin) {
      var minutes = Math.floor(state.positionSec / 60);
      // Say it plainly. Pretending they are on time makes the first thing they see a lie.
      els.notice.textContent = 'This session started ' + minutes + ' minutes ago - you are joining in progress.';
      els.notice.hidden = false;
    }

    if (state.elements && state.elements.stickyMessage) {
      els.sticky.innerHTML = state.elements.stickyMessage;
      els.sticky.hidden = false;
    }

    els.status.hidden = true;
    els.stage.hidden = false;
    els.joinBtn.hidden = false;

    // From here the room is on screen, so it reports itself whether or not anyone presses play.
    bindLifecycle();

    // A click before playing is not decoration: every browser refuses to autoplay with sound
    // without a user gesture, and a muted session is worse than a button.
    els.joinBtn.addEventListener('click', function () {
      els.joinBtn.hidden = true;
      startPlayback(phase === 'replay' ? 0 : state.positionSec);
    });
  }

  if (!token) {
    say('This link is missing its access code. Please use the link from your email.');
    return;
  }

  fetch('/.netlify/functions/wr-room?t=' + encodeURIComponent(token))
    .then(function (res) {
      return res.json().then(function (body) {
        return { ok: res.ok, body: body };
      });
    })
    .then(function (result) {
      if (!result.ok) {
        say(result.body.error || 'We could not open this session.');
        return;
      }
      state = result.body;
      render();
    })
    .catch(function () {
      say('We could not open this session. Please refresh the page.');
    });

  // Real questions to the host. Not a chat: nobody is sitting in the room pretending to be
  // there, and a message box that answers nobody is worse than one that plainly forwards.
  if (els.questionForm) {
    els.questionForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = els.questionInput.value.trim();
      if (!text) return;
      els.questionInput.value = '';
      els.questionNote.textContent = 'Sent. Kirill reads these himself.';
      fetch('/.netlify/functions/wr-question', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          t: token,
          text: text,
          positionSec: Math.floor(els.video.currentTime || 0)
        })
      }).catch(function () {
        els.questionNote.textContent = 'That did not send. Email kirill@thezerofog.com instead.';
      });
    });
  }
})();
