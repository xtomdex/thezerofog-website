# Workshop Room - our own EverWebinar, full specification

**Written 2026-08-13.** Decision by CEO the same day: do not buy EverWebinar ($199/month, or $1188
billed annually - all tiers carry the identical feature set). Build the equivalent inside the
existing site, dropping nothing.

The rule this document exists to enforce: **every EverWebinar capability is listed by name and
answered explicitly.** Where we deliberately do not build something, it says so and says why. A
capability that is simply missing from this document is a defect in the document.

Source of the capability list: `WORKSHOP-ROOM-EVERWEBINAR-INVENTORY-2026-08-13.md` (verified
against EverWebinar's own help centre, every line source-linked).

---

## 1. What we are actually building

A registration-to-replay system living entirely in the existing stack:

- Eleventy + Nunjucks pages in `thezerofog-website/src/`
- Netlify Functions in `netlify/functions/`, written in the house style: ESM, native `fetch` and
  `node:crypto`, **no npm dependencies** (this is how `stripe-webhook.js` and `create-checkout.js`
  are written and it stays that way)
- Supabase for state, reached **only** from functions using `SUPABASE_SECRET_KEY`. The baseline
  migration installs an event trigger (`rls_auto_enable`) that turns RLS on for every new table
  automatically, so tables with no policies are unreachable from the browser. That is exactly what
  we want here - no webinar table is ever touched by client code.
- Schema changes follow `docs/supabase-migration-protocol.md`: drafts go to `supabase/drafts/`,
  the migration owner applies them. Nothing in this build runs `supabase db push`.
- MailerLite and Make stay where they are. We do not replace the email platform - we replace the
  thing that decides *when* each person gets an email.

Nothing here requires a new vendor, a new subscription, or a new npm package.

---

## 2. The one real cost question

EverWebinar bundles video delivery into its price. We do not have a video host with unlimited
bandwidth, so this is the only line item that could make building worse than buying.

**The recording lives on YouTube unlisted today** (`LLUaY4viebE`, embedded in `src/workshop.njk`).
That is free but fails the room requirements in two ways: the YouTube player cannot be made
non-seekable in a way a determined viewer cannot undo, and the video ID sits in the page source,
so the whole workshop can be opened on youtube.com at any time - which destroys both the session
model and the replay window.

**Recommendation: serve the mp4 from the CloudFront distribution we already pay for through
Systeme.io** (`d1yei2z3i6k35z.cloudfront.net`), the same one serving every course lesson. It
answers HTTP range requests correctly - measured on lesson files 2026-08-13 - which is all a plain
`<video>` element needs. Cost: zero extra. Downside: the URL is public if someone reads the
network tab. That is a fair trade for a **free** workshop, and it is the same exposure the course
lessons already carry.

If we ever want real protection, the upgrade path is a signed-URL host (Bunny Stream, Cloudflare
Stream) and it changes exactly one function - `wr-room.js` returns a signed URL instead of a
static one. CEO ruling 2026-08-13: revisit only when delivery cost approaches EverWebinar's price.

---

## 3. Data model

All tables prefixed `wr_` (workshop room). Draft migration:
`supabase/drafts/DRAFT_workshop_room.sql`. **Not applied by us.**

| Table | Holds | Notes |
|---|---|---|
| `wr_config` | one row, JSONB: schedule rules, JIT interval, timecodes, replay window, room copy | editable without a deploy |
| `wr_blocked_dates` | dates on which no session is offered | holidays, launches |
| `wr_sessions` | `id`, `starts_at` (UTC), `kind` (`scheduled` / `jit` / `ondemand`), `cap`, counters | created lazily on first registration for a slot |
| `wr_registrations` | `id`, `session_id`, `email`, `name`, `token`, `timezone`, `utm_*`, `consent`, `source`, `created_at` | `token` is the unique join key |
| `wr_attendance` | `registration_id`, `first_seen_at`, `last_seen_at`, `max_position_sec`, `watched_sec`, `joined_at_position_sec`, `device`, `ended_reason` | one row per registration, upserted by heartbeat |
| `wr_events` | `registration_id`, `type`, `position_sec`, `payload`, `created_at` | join, heartbeat, offer_shown, offer_click, handout_click, poll_answer, question, exit, replay_join |
| `wr_notifications` | `registration_id`, `template`, `scheduled_for`, `sent_at`, `status`, `error` | the queue the cron drains |
| `wr_questions` | real questions typed by attendees, forwarded to the host | |
| `wr_chat_script` | `position_sec`, `author`, `text`, `enabled` | scripted chat, ships disabled - see section 8 |
| `wr_polls` / `wr_poll_answers` | timed polls and real answers | |

Every write happens server-side with the service key. No RLS policies are written, which under the
auto-enable trigger means no anonymous or authenticated client can read these tables at all.

---

## 4. Functions

| Function | Method | Job |
|---|---|---|
| `wr-slots.js` | GET | returns the next N bookable slots in the visitor's timezone: JIT slot first ("starts in 12 minutes"), then scheduled ones, minus blocked dates, minus capped sessions, respecting the "no registrations closer than X minutes" rule |
| `wr-register.js` | POST | validates, creates the session row if this slot has no registrations yet, writes the registration, mints the token, forwards the lead to Make exactly as `optin.js` does today, and **enqueues the notification rows** for this person's slot time |
| `wr-room.js` | GET `?t=` | the room's brain. Resolves the token, decides the state (`early` / `live` / `late` / `ended` / `replay` / `expired`), and returns the video source, the live position in seconds, and every timed element with its timecode |
| `wr-heartbeat.js` | POST | called every 20s by the player: updates `wr_attendance` (max position, watched seconds, last seen) and appends an event. Idempotent, cheap, no reads |
| `wr-notify.js` | scheduled, every 5 min | drains `wr_notifications`: anything due and unsent goes out through MailerLite, is marked sent, and anything whose time has already passed at registration is marked `skipped` rather than sent late |
| `wr-question.js` | POST | a real question from the room, stored and emailed to the host |
| `wr-stats.js` | GET, protected | the analytics dashboard's data source |

`optin.js` stays, but its `EVERWEBINAR_SCHEDULE_URL` redirect is replaced by our own schedule page.
That single change removes the env var that currently makes the function return 500 and drop the
lead before it reaches Make.

---

## 5. Pages

| Page | What it becomes |
|---|---|
| `/` landing | unchanged; the opt-in form now leads to our schedule step |
| `/workshop/schedule/` | slot picker: JIT option plus the next scheduled slots, localised to the visitor's timezone |
| `/confirmation/` | keeps its job, gains the chosen slot time, the countdown, and the join link |
| `/workshop/` | **becomes the room.** Token-gated. Today's temporary "watch the recording" page is what it replaces |
| `/replay/` | token-gated replay with a real expiry driven by the session that person registered for, not a hardcoded 48-hour string |
| `/workshop-text/` | unchanged - the read-instead-of-watch path stays |
| `/admin/workshop/` | numbers: registrations, show-up rate, drop-off curve, offer clicks, per-UTM breakdown |

---

## 6. Player behaviour - the part that has to feel identical

- Position is **derived, never stored**: `position = now - session.starts_at`. Reloading the page
  does not resume where you left; it drops you where the session now is. That is the behaviour
  that makes a recording feel like a broadcast.
- Native controls off. Custom bar carries volume and fullscreen only. **No seek.**
- Latecomer joins in progress at the current position, with a line saying the session started N
  minutes ago.
- Arriving before the start shows a countdown, not the video.
- Arriving after the end shows the ended state and routes to the replay or the offer.
- Timed elements fire off the same clock: the offer button, handouts, announcements, polls, and
  the chat script all carry a `position_sec` and appear when the clock passes it.
- The offer button, once shown, stays shown for the rest of the session.

---

## 7. The notification engine - why this is the piece that most needed building

Our own email README already records the problem, from the tech review of 2026-07-25: MailerLite
delay steps cannot wait until a date held in a subscriber field, so with several daily slots the
wait to session start differs per person and the T-6h / T-1h / T-15min reminders **cannot be
expressed in MailerLite at all.** The plan was to hand E1-E5 to EverWebinar's own notification
engine, which costs us a separate DKIM record and hand-pasted unsubscribe footers in every
template.

Our version removes that entirely. At registration we compute each person's absolute send times
and write them as rows. A cron function every five minutes sends what is due, through MailerLite,
where the footer and unsubscribe link are already correct. Same capability, one less sending
domain to warm up, and no hand-pasted legal footers.

---

## 8. Manufactured liveness - built, shipped off, CEO's switch

EverWebinar's remaining differentiator is manufactured liveness: a simulated attendee counter that
climbs and tapers, scripted chat timed to the recording, and "someone just bought" popups.

Two rulings already govern this and neither is mine to overturn:

- **The JIT frame itself is a confirmed CEO strategy**, not an accident - "JIT instead of a
  replay" is lifted straight from IRON and was reconfirmed 2026-07-24. We build it fully.
- **"Never assert live, never deny it"** - CEO, 2026-07-25. All nine "live" assertions were
  swapped to *starts / session / see you inside*, and Legal's proposed inoculation line
  ("this is a recorded session") was deliberately **not** added.

So: the scripted-chat schema and rendering are built, because bolting them on later means
reopening the room. They **ship disabled**. The attendee counter and the purchase popups are
scaffolded to the same switch but seeded empty. Flipping any of them on is a CEO decision made
once, deliberately - not a default that arrives with a deploy. The one thing I will not build
under any switch is a fabricated purchase popup naming a person, because we have no buyers and
the no-borrowed-proof rule is absolute.

One deliberate divergence stays regardless of the switch: **their polls take the "results" typed
in by the host as percentages and display them as if attendees voted.** Ours show real answers or
no results at all.

---

## 8a. What the funnel actually demands - and the one place we beat them

The email sequence is 21 emails whose routing depends entirely on what the room measures. The
definitions below are quoted from `_Marketing/emails/README.md`, which is the authoritative
carrier.

**Two nested timecodes drive everything.** The reveal (slide 33, about 22 minutes) and the start
of the product presentation (slide 79, about 42 minutes - moved from 92 by the 2026-07-25
fact-check). Both are **provisional until read off the final recorded master**, and both live in
config for that reason. They have moved once already.

**The subtraction is load-bearing.** "Left before X" is a prefix predicate: someone who walks out
at minute 4 satisfies both thresholds. The middle segment therefore exists only as
`exit-lt-offer AND NOT exit-lt-reveal`. Without that subtraction, a person who left at minute 4
receives the full mechanism and the price - exactly what the segmentation exists to prevent.

Segments the room must emit, and every one of them carries `AND NOT in buyers`:

```
SEG-A-noshow      = registered, never attended
SEG-B-pre-reveal  = exit before the reveal timecode
SEG-C-pre-offer   = exit before the offer timecode AND NOT SEG-B     <- the subtraction
SEG-D-stayed      = attended AND NOT exit before the offer
SEG-SAW-REVEAL    = C or D
SEG-REPLAY-EARNED = earned on the replay AND (SEG-A or SEG-B)
SEG-CLOSE         = SEG-SAW-REVEAL or SEG-REPLAY-EARNED
```

**The buyer flag comes from Stripe and never from here.** `stripe-webhook.js` already implements
it correctly and stays the single source of truth. Every send also gets a buyer guard immediately
before it, because a late Stripe webhook otherwise pitches a customer.

**A unique per-person join link is not a nicety.** A generic room URL means no attendance ever
attributes, every segment collapses to "registered", and it fails silently - looking exactly like
low engagement. This is the token.

### Where we beat EverWebinar outright

Two known holes in the EverWebinar plan close by construction here:

1. **The late-entry leak.** Their exit-minute is measured against the webinar timeline, so someone
   who joins at minute 40 and leaves at minute 50 never saw the reveal but still exits *after* it
   and lands in a mechanism-heavy branch. The team logged this as "cap the late-entry window or
   accept the leak. Decide explicitly" and never decided. **We do not have to decide.** We
   accumulate genuinely watched seconds per position, so "saw the reveal" means *watched through
   the reveal*, not *left after it*. The leak does not exist in our model.
2. **The replay watch gate.** Their replay rules offer only register / attend / purchase, and
   "attended replay" fires on merely opening the page - so a no-show who opens and closes the
   replay would receive the full mechanism and a $67 ask. The team's workaround was to gate on a
   click of the bonus link at the end of the replay. We keep that link, but we also have the real
   thing: watched seconds on the replay, same as the room. The click becomes a confirmation, not
   the only evidence.

The team had already scoped this exact rebuild for "later" - self-hosted replay, watched seconds
accumulated from `timeupdate` rather than `currentTime` so scrubbing past the reveal cannot count
it, a beacon at the threshold, and a real tokenised expiry. That note is effectively a spec for
the replay module and this build follows it.

---

## 8b. Three edge cases the old plan left open - decided here

The source documents flag these as never decided. Silently inheriting the ambiguity is how they
become bugs, so each gets an answer, and each answer is a CEO override away from changing.

1. **Someone buys before their session starts.** Proposal: reminders stop immediately, the room
   stays open. They paid; being nagged to attend a sales presentation is the wrong experience, but
   locking them out of content they were promised is worse.
2. **Someone registers a second time for a different slot.** Proposal: the new slot wins, the old
   registration's queued reminders are cancelled, and the token stays the same person. The failure
   mode the old plan feared - a queued reminder holding a stale slot time - disappears because our
   reminders are rows that can be deleted, not delays running inside an email platform.
3. **The 48-hour replay window.** It is currently a `localStorage` countdown with nothing behind
   it: it says "expired" and then serves the video and the $67 button anyway, and it restarts on a
   repeat visit. Legal flagged this in July as deceptive urgency under FTC Section 5, and CEO
   already decided it must be real before ads send traffic to `/replay/`. Here it becomes real:
   the deadline is per-registration, server-side, and expiry actually closes the page.

---

## 8c. Contracts we must not break

- **`/confirmation/` currently reads EverWebinar's `wj_*` query parameters** - `wj_lead_first_name`,
  `wj_lead_email`, `wj_event_ts`, `wj_event_tz`, `wj_next_event_date`, `wj_next_event_time`,
  `wj_lead_unique_link_live_room` - to show the greeting, the add-to-calendar buttons and the join
  link. None of it has ever fired, because nothing has ever redirected there with those params.
  Our schedule step supplies the same values under our own names and the page keeps every feature
  it was built for.
- **`optin.js` returns `{ ok, redirectUrl }`** and `index.js` appends the five UTM params to it
  before redirecting. That contract is not EverWebinar-specific and does not change - only the URL
  behind it does.
- **The consent beacon fires before navigation** (`sendBeacon`, deliberately) because the redirect
  leaves the page. Keep the ordering.
- **Naming.** No customer-facing text and no admin label says "webinar" or "training" - CEO,
  2026-08-11. It is a *workshop*, and a *session*. The two deliberate exceptions stay exceptions:
  the legal pages, where "Webinar" is a defined term, and the recorded course audio.
- **Sender identity.** Transactional mail from this system goes out as `hello@thezerofog.com`,
  replies to `kirill@`. `support@` was retired from copy on purpose - a one-man founding operation
  promising a support desk contradicts the workshop.

### A saving nobody has counted yet

MailerLite's free tier was cut to 3 automations of 5 steps on 2026-08-13, and this funnel needs
six to eight automations of eight to fourteen steps - which is why a paid tier was being priced
in. Once our system owns the timing and the segmentation, MailerLite is only a sender. Whether
that drops us back under the free ceiling depends on how the sends are wired, and it is worth
checking before anyone upgrades a plan.

---

## 9. Capability-by-capability answer to EverWebinar

Every line of the verified inventory, answered. Labels: **BUILD** = in this build.
**HAVE** = already exists in our stack. **LATER** = deliberately deferred, with the reason.
**NO** = deliberately not built, with the reason. **N/A** = meaningless outside their product.

### Scheduling

| EverWebinar | Us |
|---|---|
| Specific date/time session | BUILD - a `wr_sessions` row with an explicit `starts_at` |
| Recurring daily/weekly schedule | BUILD - rules in `wr_config`, slots computed, not stored |
| Just-in-Time, interval 15/30/45/60 min | BUILD - same intervals, configurable |
| Instant replay / on-demand option on the reg page | BUILD - a config toggle that offers "watch now" as a slot |
| Hybrid: recording plus a live staffed chat room | NO - nobody is staffing a chat room. The real-question box below covers the useful half |
| Timezone: fixed or auto-localised | BUILD - both; auto-localised is the default |
| Late joiner fast-forwarded to live position | BUILD - it is the core of the player, not a feature |
| Block registrations closer than X to start | BUILD - `min_lead_minutes` in config |
| How many upcoming slots to display | BUILD - config |
| Blocked dates | BUILD - `wr_blocked_dates` |
| Always-On room | BUILD - a session of kind `ondemand` |
| Session capacity cap | BUILD - `cap` column, unused by default (they may not even have this) |

### Registration

| EverWebinar | Us |
|---|---|
| Hosted, editable registration page | HAVE - our landing page, which is better than any template they ship |
| Embeddable form: bar, popup, bubble, static | NO - we own every page we advertise on; there is no third-party site to embed into |
| One-click registration from an email link | BUILD - a signed link that registers a known subscriber without a form. Needed for re-inviting the list |
| Auto-subscribe to future webinars | N/A - MailerLite already holds the list |
| Direct access link, no registration | BUILD - used for our own previews and for CEO to check the room |
| Registration API | BUILD - `wr-register` is the API; Make can call it |
| Custom registration fields | BUILD - field list in config; today it is email plus name |
| A/B testing of registration pages | HAVE - Netlify split testing on branch deploys |
| Confirmation / thank-you page | HAVE - `/confirmation/`, gains the slot time and join link |
| Post-registration survey | LATER - real value only once traffic exists; the schema takes it without a rebuild |
| Countdown holding page before start | BUILD - the room's `early` state |
| Unique join link per registrant | BUILD - the token. Ours is unambiguous: one token, one registration, valid until the replay expires |
| Password-protected room | NO - the token is strictly stronger than a shared password |
| Turn registrations off, with redirect | BUILD - config flag |
| GDPR consent gating the register button | BUILD - mandatory consent checkbox, stored on the registration row |

### Notifications

| EverWebinar | Us |
|---|---|
| 10 pre + 10 post notifications, individually timed | BUILD - the queue is generic; the count is not limited to 10 |
| Signup confirmation, on by default | BUILD - this is E1 |
| Double opt-in | LATER - config flag; MailerLite can also do it natively |
| Pre-webinar reminders at chosen offsets | BUILD - E2 at T-6h, E3 at T-1h, E4 at T-15min |
| Fixed 15-minute last-minute reminder | BUILD - same slot as E4 |
| Post-webinar follow-ups keyed to behaviour | BUILD - this is the whole segmentation engine |
| SMS reminder (Twilio) | NO - we do not collect phone numbers, and adding Twilio adds a bill and a consent problem. Reversible: the queue does not care what channel a row is sent through |
| Voice-call reminder (Twilio + hosted mp3) | NO - same reason |
| Delivery method per notification | BUILD - MailerLite is the sender for all of them |
| Custom sender, shortcodes, DKIM | HAVE - through MailerLite, which is **better than theirs**: no second sending domain to warm up and no hand-pasted unsubscribe footer |
| Skipping notifications whose time already passed | BUILD - rows whose `scheduled_for` is in the past at creation are marked `skipped`, never sent late |

### The room

| EverWebinar | Us |
|---|---|
| Automated playback at the session moment | BUILD |
| Host toggle for viewer seek controls | BUILD - off in the room |
| Latecomer fast-forward | BUILD |
| Simulated attendee counter that climbs and tapers | NO - manufactured liveness. See section 8 |
| Scripted chat timed to the recording | BUILD BUT DISABLED - schema and rendering exist, switched off. See section 8 |
| Real attendee questions to a moderator | BUILD - question box, stored and emailed to the host |
| Polls, timed | BUILD - **with one deliberate difference.** Their poll results are typed in by the host as percentages and shown as if they were votes. Ours show real answers or no results at all |
| Surveys at the confirmation step | LATER - same as post-registration survey |
| Handouts released at a timestamp | BUILD |
| Timed announcements | BUILD |
| Offer / CTA at a timestamp, with urgency timer | BUILD - and once shown it stays shown |
| "Someone just bought" popups | NO - fabricated proof, and we have no buyers to be honest about yet |
| Sticky message | BUILD - trivial, useful for a support link |
| Replica Replay import from WebinarJam | N/A - there is no WebinarJam session to import |
| Video from mp4 / YouTube / Vimeo / S3 | BUILD - the source is a URL in config; see section 2 |
| Mobile | BUILD - the site is already responsive; the room inherits it |
| "The webinar has ended" state | BUILD |
| Auto-redirect when the session ends | BUILD - configurable target, defaults to the replay |

### Replay

| EverWebinar | Us |
|---|---|
| Replica replay / custom video / external redirect | BUILD - all three as a config choice |
| Seek toggle on replay | BUILD - **default allowed.** A replay is openly a replay; there is nothing to preserve by forbidding it |
| Show or hide the original chat | BUILD - off, since chat itself is off |
| Expiry window, configurable hours | BUILD - and unlike today's page, the countdown is real, computed from that person's own session |
| Offer reproduced at its timestamp | BUILD, and ours can carry a different timecode on replay, which theirs may not |
| Replay attendees and revenue tracked separately | BUILD |
| Question box on replay forwarding to email | BUILD |

### Analytics

| EverWebinar | Us |
|---|---|
| Registration-page visitors, sign-up rate | HAVE - PostHog is already wired into the site for funnel analytics |
| Total registrants; live vs replay attendees; show-up rate | BUILD |
| Duration, average watch time, % who watched it all | BUILD |
| Retention graph at 5-minute intervals | BUILD - we hold every heartbeat, so ours can be finer than 5 minutes |
| User ratings | LATER - one-question rating at the end, cheap to add once there is traffic |
| Paid registrations and registration revenue | N/A - our workshop is free |
| Purchases and revenue, live and replay separately | BUILD - joined to Stripe by email through the existing `stripe-webhook.js` path |
| Conversion rate, earnings per attendee | BUILD |
| Email performance: sent, opens, clicks, failures | HAVE - MailerLite reports it |
| Split-test metrics per version | HAVE - Netlify |
| Session-time comparison, which slots perform | BUILD - grouped by `starts_at` local hour |
| Export for a chosen period | BUILD - CSV |
| UTM lead-source breakdown | BUILD - UTMs are captured on the registration row, so every metric can be sliced by them |

### Segmentation and integrations

| EverWebinar | Us |
|---|---|
| Native integrations (Kajabi, HubSpot, MailerLite, Drip...) | N/A - we integrate directly with the two we use |
| Custom webhooks on registrant events | BUILD - every event type can fire to Make |
| Webhook auth: bearer / header / none | BUILD - bearer |
| Different events routed to different endpoints | BUILD - an event-to-URL map in config |
| Zapier | N/A |
| REST API for registering and listing | BUILD - our functions are the API |
| Automatic CRM tags from behaviour | BUILD - segment tags pushed into MailerLite |
| GDPR consent stored as a tag | BUILD |
| Behaviour-based follow-up routing | BUILD - the reason this project exists |

### Admin and account

| EverWebinar | Us |
|---|---|
| Multiple webinars in one account | BUILD - config is keyed by webinar slug even though we run one |
| A/B testing registration pages | HAVE - Netlify |
| Team members with permissions | N/A - no second product to administer |
| Owner-only reserved settings | N/A |
| Presenter and moderator access links | NO - nobody presents live |
| Meta Pixel on every funnel page | HAVE - already consent-gated site-wide; the room and replay pages inherit it |
| GDPR module: consent wording, mandatory flags, cookie banner, auto-deletion after N months | PART HAVE, PART BUILD - the cookie banner and consent gate exist; the configurable consent wording and the scheduled deletion of old leads are built here |
| Custom sending domain with DKIM | HAVE - MailerLite |
| White-label domain for room and replay pages | HAVE, and better - the room lives on thezerofog.com, not on a vendor's domain. This is one they may not even offer |

### Deliberately not built - the full list in one place

SMS and voice reminders (no phone numbers, extra vendor, extra consent). Embeddable third-party
forms (no third-party sites). Password-protected rooms (tokens are stronger). Hybrid staffed chat
and presenter/moderator roles (nobody is staffing). Simulated attendee counter and live sale
alerts (manufactured proof). Fake poll percentages (we show real answers or none). Zapier and
native CRM connectors (we integrate directly). Replica Replay import (nothing to import).

Deferred with the schema already able to take them: post-registration surveys, double opt-in,
end-of-session ratings.

---

## 10. Legal pages - a required, not optional, follow-up

Three published pages name EverWebinar as a data processor and must be corrected the moment this
ships, because naming a processor we do not use is itself a privacy misstatement:

- `src/privacy.njk` - line 46 (name collected "within the webinar platform (EverWebinar)"),
  line 73 (registers you for webinars "via EverWebinar"), **line 98 - the processor listing
  itself**, and line 109 (the list of countries data is transferred to).
- `src/terms.njk` - line 46 defines "Webinar" as hosted "through the EverWebinar platform";
  line 58 and line 146 name it again in the third-party list. The definition's
  "live, simulated-live, or recorded" umbrella does not need changing - only the vendor.
- `_Marketing/FUNNEL-PAGES-MAP-2026-07-09.md` - four lines describing the EverWebinar path.

The replacement is not "delete EverWebinar" - it is naming what actually processes the data now:
our own infrastructure (Netlify, Supabase), and whatever serves the video. Each legal page has a
canonical `.md` source in `src/_data/legal/` that must be edited first, then ported to the `.njk`.
This is a CEO-and-Dima item, not a solo edit - the standing rule is that compliance findings are
never applied alone.

---

## 11. Build order

**DONE 2026-08-13** (all under `thezerofog-website/`, ~1650 lines, every file syntax-checked):

1. `netlify/functions/lib/wr-time.js` - timezone and slot maths. 41 assertions pass, including
   both DST transition nights and the delivery window. One real bug was caught and fixed here: a
   wall-clock time that does not exist on the spring-forward morning was resolving an hour
   **backwards**, so a 2:30am slot would have become 1:30am.
2. `netlify/functions/lib/wr-db.js` - PostgREST over native fetch, CSPRNG tokens, no npm.
3. `netlify/functions/lib/wr-config.js` - the whole behaviour of the room as one config object,
   plus `deriveSegments()`. 16 assertions pass, including the nested subtraction.
4. `netlify/functions/wr-slots.js` - bookable sessions in the visitor's own timezone.
5. `netlify/functions/wr-register.js` - registration, token, queue, Make forward. Server-side
   slot validation: the schedule is recomputed and an exact match required, so a client cannot
   book a time we never offered.
6. `netlify/functions/wr-room.js` - session state, playhead position, timed elements. The only
   route by which the video URL reaches a browser.
7. `netlify/functions/wr-heartbeat.js` - watched-seconds accumulation, clamped against wall-clock
   elapsed time so the browser cannot claim a full watch it did not do, and segment derivation.
8. `supabase/drafts/DRAFT_workshop_room.sql` - seven tables, written to match the code above.
   **Not applied.** Three deviations from the project's standard model are flagged in the file
   for the owner: no `auth.users` link (registrants are anonymous leads), RLS on with no policies
   rather than own-row policies, and narrower grants.

9. `netlify/functions/wr-notify.js` - scheduled every five minutes. Re-checks the segment AND the
   buyer flag at send time, not at queue time: somebody who bought an hour after the session was
   not a buyer when the row was written.
10. `netlify/functions/wr-question.js`, `wr-retention.js` (daily deletion past the retention
    window), `wr-stats.js` (every metric their dashboard shows, key-protected).
11. `src/workshop-schedule.njk` + JS + CSS - the schedule step, live at `/workshop/schedule/`.
12. `src/workshop-room.njk` + `workshop-room.js` + CSS - the player. No seek, playhead pinned to
    the server clock, watched seconds from `timeupdate` deltas, beacon on exit.
13. `src/replay.njk` + `replay.js` - the fake countdown **deleted**, replaced by the real
    server-side deadline in the room.
14. `optin.js` - `EVERWEBINAR_SCHEDULE_URL` removed entirely, along with the 500 it caused.
15. `confirmation-2.js` - rewritten off our own parameters. The greeting, the registrant details
    and the calendar buttons were dead code on a live page, waiting for `wj_*` params that
    nothing was ever going to send.
16. `stripe-webhook.js` - now also stamps `purchased_at`, best effort, never failing the webhook.
17. Docs: site `CLAUDE.md` and `.env.example` brought in line.

**Verified by running it, not by reading it:** 41 assertions on the time maths including both DST
nights, 16 on segment derivation including the nested subtraction, 11 on the slots endpoint with
the **database deliberately unreachable** - it still returns six bookable sessions, because a lead
arriving while Supabase is asleep must see times rather than an error.

**NEXT - and most of it is not mine**

18. Dima applies `supabase/drafts/DRAFT_workshop_room.sql`. Verified against the live database
    2026-08-13: `public` holds five tables and none of them is `wr_*`, so nothing collides.
19. Dima wires one Make scenario: it receives `{type: 'workshop_notification', template, email,
    ...}` and sends that template through MailerLite. One scenario, not eight - our side decides
    who and when.
20. CEO uploads the master to the CloudFront distribution that already serves the lessons, and
    reads the two timecodes off it. Until then the config points at the YouTube placeholder.
21. End-to-end run on a Deploy Preview with real email delivery.
22. Legal-page pass with CEO and Dima - `privacy.njk` still lists EverWebinar as a processor.

Not started until the recording is final: the two timecodes. They are read off the master, never
estimated from the script - the duration headers in this project have lied before.
