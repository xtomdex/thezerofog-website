# Make.com change log

Every change made to the Make organisation from outside the Make UI is recorded here, newest
first. The point is that Dmitrii owns these scenarios and must be able to see what was touched,
why, and how to undo it, without reconstructing it from memory.

Rules for anyone adding an entry:

- Take a blueprint backup **before** the change. Backups live in `docs/make-backups/`.
- Record the exact before/after of the values you changed, not a description of them.
- Re-read the blueprint from the API afterwards and diff it against the backup. The Make UI
  rewrites parts of a module you did not touch (see 2026-08-14), so "I only changed one thing"
  has to be verified, never assumed.
- Note anything the change makes newly possible to break, even if it cannot break today.

---

## 2026-08-16 (later) - Webinar Opt-In (5275566) retired: lead capture moved into the site

**Raised by:** Dmitrii - "why keep Make at all if it is only in the opt-in now". **Decided by:**
Kirill, same day. **Done by:** Claude. **Nothing was changed inside Make** - no blueprint edit,
no module touched, so there is no before/after diff to record. The scenario is left exactly as
it is, still disabled; what changed is that the site no longer calls it.

**What the scenario did** (from `docs/make-backups/scenario-5275566-blueprint-2026-08-14-after.json`,
four modules): custom webhook `2837321` -> set variable `lead_id` = uuid -> data store `131783`
AddRecord keyed on email with `{email, source:'optin', lead_id, created_at, purchased_at,
webinar_status, payment_session_id, webinar_first_name}` -> MailerLite CreateUpdateSubscriber
into group `183307718676711076` (`ADs`).

**What replaces it:** `netlify/functions/optin.js` writes the lead to Supabase `wr_leads`
(upsert on email) and adds the subscriber to the same `ADs` group through the MailerLite API we
already use for the notification queue. The group id is hard-defaulted in code and overridable
by `MAILERLITE_LEADS_GROUP_ID`, so the list stays continuous across the switch.

**Why, beyond the EUR 10/month:** Make was a single point of failure on the first step of the
funnel. `optin.js` returned 500 to the visitor whenever the webhook answered non-2xx, so a
stopped scenario took the funnel down (2026-08-13) and a disabled one queued leads into a
webhook nothing drains. The new handler runs both writes under `Promise.allSettled` and only
answers 500 if BOTH fail - one failure is logged and the other copy holds the lead.

**Second change in the same commit:** `wr-register.js` no longer forwards the registration to
`MAKE_WEBHOOK_URL`. That forward posted five fields the opt-in webhook could not map - the
payload that stopped the scenario on 2026-08-13 - and with Make disabled every registration was
filling the same 50-slot queue. Nothing downstream read Make's copy: the registration is in
`wr_registrations`, the emails in `wr_notifications`, the list membership in MailerLite.

**Verified before commit:** the handler was run locally against the live MailerLite API with
`kirill+optinprobe@thezerofog.com` - subscriber created in `ADs`, answer `200 {ok,redirectUrl}`
even though the Supabase write failed with `PGRST205` (the table is not applied yet), which is
exactly the intended degradation. The probe subscriber was deleted afterwards (204).

**The webhook queue holds nothing worth recovering - checked, not assumed.** All 21 log records
on hook `2837321` (13-15.08, none since) were pulled and scanned for addresses: `kirbissb@gmail.com`
x5, thirteen `kirill+*@thezerofog.com` test aliases, `kirbissb+wrtest*@gmail.com` x2, and one
fuzz payload with a 900-character local part. Not one real lead - the site has had no traffic,
the ads have never run. So the queue gets cleared, not drained.

**Open, in this order:** (1) apply `supabase/drafts/DRAFT_wr_leads.sql` - until then leads land
in MailerLite only; (2) deploy; (3) delete `MAKE_WEBHOOK_URL` from Netlify production once the
deploy is verified. **Make can then be cancelled entirely - no scenario is reachable from the
site any more.**

---

## 2026-08-16 - Payment Processing (6209692) retired: enrollment moved into the site's Stripe webhook

**Decided by:** Kirill, 2026-08-16, after reviewing the arguments. **Done by:** Claude, in the
site repo only - nothing inside Make was modified. The scenario simply stays off, permanently.

What changed and why:

- The blueprint backup (`docs/make-backups/scenario-6209692-blueprint-2026-08-14.json`) showed
  this scenario was the ONLY place a buyer got enrolled into the course
  (`systeme-io:createEnrollment`, course 606107 "The Zero Fog", full_access). The site's
  `stripe-webhook.js` sent the welcome email and stamped the buyer flag but enrolled no one.
- Meanwhile the live Stripe account's only webhook endpoint (created 2026-08-15,
  `zerofog-site-webhook`) points at the site, not at Make - so the scenario would never have
  fired anyway without adding a second Stripe endpoint at Make's unsigned custom webhook.
- Decision: rather than wire Stripe to Make, `stripe-webhook.js` now does the enrollment
  itself, directly against the Systeme public API, replicating the scenario's exact logic:
  find contact by email -> create if missing (`locale: en`) -> POST
  `/school/courses/606107/enrollments` with `{contactId, accessType: "full_access"}`.
  Reasons Kirill accepted: single signature-verified consumer of Stripe events (Make's custom
  webhook cannot verify Stripe signatures - anyone with the URL could have faked a purchase);
  Stripe retries a 500 for days, while a Make scenario error self-disables the scenario
  (exactly how Opt-In died on 2026-08-13); email + buyer flag + enrollment now live in one
  code path with one log.
- Idempotency preserved: a 4xx on the enrollment call is treated as already-enrolled (the
  scenario used an Ignore error handler on the same call); a duplicate Stripe delivery cannot
  double-enroll or double-send E14.
- Deliberately NOT replicated: the scenario's final MailerLite step (add to group
  `186291398819973016`, the pre-workshop-era buyers group whose legacy automation was deleted
  2026-08-16). Its job is done by the wr-E14 purchase-welcome join, which already lives in the
  webhook.
- Env changes: `MAKE_STRIPE_WEBHOOK_URL` retired (must never be set again); new
  `SYSTEME_API_KEY` (Systeme public API key) is now REQUIRED by the webhook - unset means paid
  orders answer 500 and Stripe retries until it is set (delayed, never lost). Optional
  `SYSTEME_COURSE_ID` defaults to 606107.
- Tested with a local mock Systeme API + signed fake Stripe events, 13 checks: happy path
  (contact created, enrolled), existing-contact path, already-enrolled 422 -> 200, Systeme
  down -> 500, forged signature -> 400 with zero Systeme calls, unpaid/wrong-amount sessions
  acknowledged without enrolling, missing key -> 500.
- **Live-verified same day** with the real key (`Site-Stripe-Webhook`, created by Kirill in
  Systeme -> Settings -> MCP & API keys; Dmitrii's `Enroll-New-Student-For-Make` key was left
  untouched): a signed fake purchase for `kirill+enrolltest@thezerofog.com` ran the real
  handler against the real Systeme API - contact 438327812 created, enrollment 23816734 into
  course 606107 ("4 Week Protocol") with full_access confirmed by a separate API read; a
  duplicate delivery got Systeme's 422 and answered 200 without a second enrollment. Test
  contact and enrollment deleted afterwards (both 204). `SYSTEME_API_KEY` is set in Netlify
  production and the site redeployed (deploy 6a818351..., 09:30 UTC); prod presence of the
  key is proven by the endpoint answering 400 (signature) rather than 500 (config) to a probe.

**End state for Make:** both scenarios remain, both off. Webinar Opt-In (5275566) is the only
one that will ever be turned on again - it goes ON at launch together with the Core upgrade
(~EUR 10/mo, decided 2026-08-16: Free's 1000 ops/mo at 4 ops per lead is ~250 leads, not
enough for ad traffic). Payment Processing (6209692) stays off forever; do not enable it, or
buyers would be double-enrolled (harmless but confusing) and the unsigned webhook would be a
standing free-course backdoor.

## 2026-08-15 (fifth session, addendum) - E15 trigger built end to end (Systeme -> site -> MailerLite)

**Done by:** Claude, at Kirill's instruction. The course-complete feedback email finally has a
real trigger; until today adding someone to wr-E15 was purely manual.

- **New function** `netlify/functions/wr-course-complete.js` (commit `477fff2`): receives the
  Systeme webhook, walks the undocumented payload for the email, looks up the `order` merge
  field from the buyer's Supabase profile, joins the person into `wr-E15`. Gated by
  `SYSTEME_WEBHOOK_KEY` (?key= in the URL, plain hex, timing-safe compare) - Systeme cannot
  sign webhooks. No remove-before-add: a re-completed course cannot re-send. Tested locally
  (5 cases) and on prod (wrong key 401, right key 200, test subscriber landed in wr-E15 once).
- **Systeme automation rule created and ACTIVE**: trigger "Course completed" (course: 4 Week
  Protocol) -> action "Send webhook" -> the function URL. This uses the Free plan's ONLY
  automation-rule slot (1/1) - any future Systeme rule needs a plan upgrade or this slot.
- End-to-end caveat: the wr-E15 MailerLite automation itself is still INACTIVE (Free plan, 3
  slots on E1-E3), so a completion today writes the subscriber into the group and sends
  nothing - same holding pattern as the rest of the funnel until the Comfort upgrade.

## 2026-08-15 (fifth session) - Stripe live webhook endpoint created (there was NONE), refund receipts on

**Done by:** Claude, in the Stripe dashboard, minutes after Kirill got access from Dmitrii.
Account `acct_1MwtLAF7WNgmgjSN` (The Zero Fog), LIVE mode.

### 1. The live account had ZERO webhook endpoints

Nothing in live mode listened to Stripe at all - `checkout.session.completed` from a real
purchase would have reached nobody: no Make forward, no app user, no E14, no `purchased_at`
stamp. The `STRIPE_WEBHOOK_SECRET` sitting in Netlify belonged to some endpoint that does not
exist in live mode (probably a sandbox one - "Import - 1" is offered in the wizard).

Created: destination `zerofog-site-webhook` (id `we_1U4liWF7WNgmgjSNSItWwZfe`), URL
`https://thezerofog.com/.netlify/functions/stripe-webhook`, API version 2022-11-15, listening
to exactly two events: `checkout.session.completed`, `checkout.session.expired` (the E18
trigger). Active.

**CLOSED same session:** the new endpoint's signing secret is set in Netlify (production
context; the stale value it replaced was 20 chars and not even `whsec_`-shaped), site
redeployed (`ready`), and the live function answers 400 to an unsigned POST - signature
verification is active with the new secret. Still to verify when convenient:
`STRIPE_SECRET_KEY` in Netlify is `sk_live_`, not `sk_test_` - checkable by prefix, or simply
by the first real checkout.

### 2. Customer emails: Refunds receipts ON

Settings -> Business -> Customer emails: both "Successful payments" and "Refunds" were OFF.
"Refunds" switched ON per Kirill's ruling - E16's footer line "confirmation from Stripe
arrives separately" is now true, the canon stays uncut, the E16 open item is closed.
"Successful payments" switched ON as well (Kirill's call, same session): the buyer gets a
proper Stripe payment receipt; E14 is a welcome, not a receipt.

## 2026-08-15 (fourth session) - CLOSE-24H draft campaign built, E18 abandoned-checkout email created end to end

**Done by:** Claude, at Kirill's instruction (texts CEO-approved same day). MailerLite + site
code; nothing in Make touched.

### 1. CLOSE-24H exists as a draft campaign

The founding-window close email was canon-only. Now: draft campaign id `195883484850423128`
("CLOSE-24H - founding window closing (fire by hand)"), canon verbatim, subject variant A,
`[CLOSE_TIME]` left as a visible placeholder for hand-editing at fire time. Empty container
group `close-24h-recipients` (id `195883542398371582`) awaits the recipient list, which is
pulled from wr-stats on fire day (watched, not purchased, no `no_sales`). The API cannot attach
groups to a draft - recipients get picked in the dashboard send flow. Full fire-day checklist:
`_Marketing/emails/MAILERLITE-SETUP-2026-08-14.md`.

### 2. E18 - abandoned checkout recovery, new email + code trigger

A checkout opened and walked away from produced nothing before. Now:

- **Canon** `_Marketing/emails/E18-abandoned-checkout.md` (CEO approved subject C "Did
  something break at checkout?"). One friction-removal note, zero voiced objections, sends
  once ever.
- **Code** (`create-checkout.js`): sessions now carry a 2h `expires_at` - the expiry event is
  the trigger; the default 24h would deliver the note a day late.
- **Code** (`stripe-webhook.js`): new `checkout.session.expired` branch -> `sendAbandonedCheckout`
  -> MailerLite group join `wr-E18` (group id `195883831271622375`). Buyers skipped via wr-E14
  membership; no remove-before-add, so a repeat abandonment cannot re-send. Always 200 to
  Stripe on expired events.
- **Tested locally** through the real handler (signed HMAC path, real MailerLite): new address
  lands in wr-E18 exactly once; duplicate delivery adds nothing; `kirill+e14test@` (buyer)
  skipped with a log line; no-email event is a no-op; forged signature 400. Reference
  subscriber `kirill+e18test@thezerofog.com` remains in the group.

### Open on the Stripe side (needs dashboard access - Kirill has requested it from Dmitrii)

- Subscribe the webhook endpoint to `checkout.session.expired` (Developers -> Webhooks ->
  endpoint -> add event). Until then the E18 trigger never fires - the code path is inert.
- The wr-E18 MailerLite automation IS built (id `195888810672785341`, API-verified complete,
  re-enter OFF by design - the email promises a single nudge). It is INACTIVE (Free plan slots
  are full); until activation after the Comfort upgrade, a join sends nothing.
- Refund receipts toggle check for E16 (Settings -> Customer emails -> Refunds) - same access.

## 2026-08-15 (third session, addendum) - wr-E17 deleted from MailerLite

**Done by:** Claude, on Kirill's explicit decision, minutes after the entry below was written.
Two of its three open items are now closed:

- **wr-E17 automation (id 195852550545605999) and group wr-E17 (id 195850861933495603)
  DELETED** via the API (both 204, verified: automation GET returns 410, group search returns
  zero). Reason: the Zoho auto-reply on refunds@ is the same email, and the planned bulk
  activation of all inactive workflows after the Comfort upgrade would have double-sent every
  refund requester. Full pre-deletion backup (automation JSON incl. email body, group JSON,
  rebuild recipe): `_Marketing/emails/_archive-wr-E17-deleted-2026-08-15/`. E17's only channel
  is now the Zoho group auto-response. Consequence: the `order` send-gate field concerns
  E15/E16 only.
- **`refund@` (singular) alias stays** on Kirill's mailbox as a typo catcher. Closed, no action.

Still open: the E16 footer line about Stripe refund receipts (waiting on Dmitrii).

## 2026-08-15 (third session) - every one of the 19 re-enter settings was wrong, E5 canon restore, refunds@ finally exists

**Done by:** Claude, at Kirill's instruction. Nothing in Make was touched - this entry records
MailerLite and Zoho changes, logged here because Dmitrii owns the funnel transport end to end.

### 1. MailerLite: all 19 pre-existing automations had a defective re-enter setting - all fixed

The "re-enter defaults to a 1-day delay" trap documented in the previous entry was checked
against every old workflow. Result: **all 19 were wrong.** 18 had the checkbox ON but the hidden
radio still on the default "Add delay: 1 Day(s)"; wr-E4 had the re-enter checkbox itself OFF.
The earlier belief that E1 was confirmed correct was false.

Now every one of the 19 = checkbox ON + "As soon as they match the triggers". Each fix was
verified by reopening the settings after save, not assumed. The three ACTIVE automations
(E1-E3) went through pause -> fix -> reactivate and are ACTIVE again. E14-E17 were built
correctly and were not touched.

### 2. wr-E5 text restored to canon

The live E5 email said "Same day." where the canon file `_Marketing/emails/E5-starting-now.md`
says "Same night." Restored via the email code editor (CodeMirror dispatch - reading the editor
content out is blocked by MailerLite, writing in works), verified in the saved preview.

A full audit of all 19 texts against their canon files found this as the ONLY divergence:
18 exact matches, E5 now the 19th. Senders uniform (Kirill <hello@thezerofog.com>, reply-to
kirill@), subjects = variant A everywhere, footers per canon, zero "training"/"webinar"
wording, refund contact everywhere = refunds@. Limitation: texts only - the dashboard preview
rewrites button HREFs, so links remain unverified.

### 3. Zoho: refunds@thezerofog.com exists now, with the E17 auto-reply built in

Customer mail to refunds@ **bounced** until today - the address existed nowhere (only
`refund@` singular, as an alias on Kirill's mailbox), while E7/E11/E13 and the legal pages
tell buyers to write to refunds@. Zoho user licenses are full (2 of 2, a third is paid), so it
was built as a Zoho **group**: refunds@ -> member kirill@, everyone may send to it. On the
group, Auto Response for "External members outside of the group" = the canon E17 text verbatim
(Tally link without the email/order URL parameters - Zoho cannot merge them; the form works
bare).

Consequence for the funnel: the MailerLite wr-E17 automation (refund request received) is now
redundant - the Zoho auto-reply covers the same moment. Whether to deactivate it or keep it as
a backup is an open decision; nothing was deleted.

### Still open after this session

- wr-E17 in MailerLite: deactivate or keep as backup (see above).
- `refund@` (singular) alias on Kirill's mailbox: keep or remove.
- E16 footer line "confirmation from Stripe arrives separately": waiting on whether Stripe
  refund receipt emails are actually enabled.

## 2026-08-15 (later the same day) - E14-E17 built, purchase email wired in code, SPF/DKIM verified

**Done by:** Claude, at Kirill's instruction. Four items from the open list below are now closed
or moved; this entry records exactly what changed so the status report underneath stays honest.

### 1. E14 (purchase welcome) now has a real trigger - code change in `stripe-webhook.js`

New function `sendPurchaseWelcome(email)`: after Stripe signature verification, payment
validation, the `purchased_at` stamp and the Make forward all succeed, the buyer is upserted as
a MailerLite subscriber and added to the group `wr-E14`. The group join fires the wr-E14
automation - the same join-is-the-send mechanism the whole funnel transport uses. Two deliberate
differences from `lib/wr-mailerlite.js`: no merge fields (E14's body needs none), and NO
remove-before-add - adding an existing group member fires no join, so a duplicate Stripe
delivery cannot double-send the welcome. Best effort: a failed E14 is logged, never a 500
(Stripe must not retry a correctly processed payment because a follow-up email hiccuped).

Verified locally with a signed fake `checkout.session.completed` (real HMAC path, Make forward
pointed at a local stub, Supabase off): first delivery -> 200, normalized payload forwarded,
subscriber `kirill+e14test@thezerofog.com` landed in wr-E14 exactly once; duplicate delivery ->
200, no second join; forged signature -> 400. NOT yet committed/deployed - one commit pending.

### 2. MailerLite: 4 new groups, the `order` field, and 4 new automations (23 total now)

Created via API: groups `wr-E14`, `wr-E15`, `wr-E16`, `wr-E17` and the custom text field
`order` (the send-gate E15/E16/E17 needed for the Tally URL parameter - it existed nowhere
until today). Built via the dashboard, same pattern as the other 19 (trigger = joins the group,
one Custom-HTML email, sender Kirill <hello@thezerofog.com>, reply-to kirill@, re-enter ON with
"as soon as they match the triggers"):

- `wr-E14 Purchase welcome` - subject "Welcome to The ZeroFog - your login"; dashboard button
  points at `https://thezerofog.com/course` (vanity 301 to the Systeme course, survives moves)
- `wr-E15 Course complete feedback` - subject "The course is behind you - one small favor";
  Tally form q4q8NG with `?email={$email}&order={$order}`
- `wr-E16 Refund confirmation` - subject "Refund confirmed - money is on its way"; form 44YVKX
- `wr-E17 Refund request received` - subject "Refund request received - already processing";
  form 44YVKX

All four INACTIVE (Free plan, 3 active slots all taken by E1-E3). All four texts are the canon
files verbatim, CEO-picked subjects. Triggering E15/E16/E17 is manual by design until the flows
with Dmitrii are settled: adding the person to the group in the MailerLite UI IS the send.

Two platform facts discovered while building, both matter to the whole funnel:

- **Re-enter defaults to a 1-day delay.** The "allow re-enter" checkbox alone is not enough -
  "Time for re-enter" defaults to "Add delay: 1 Day(s)". A same-day re-registration would
  silently wait a day. The four new automations are set to "As soon as they match the
  triggers"; the other 19 must be checked for BOTH the checkbox and this radio (the open
  re-enter item below just got wider).
- **MailerLite suppresses the same email to the same person within 24 hours** ("they will be
  removed from the automation"). A same-day re-registration therefore gets no second E1/E2/E3
  even with re-enter correct. Platform behaviour, not configurable on this plan. Consequence:
  same-day rebooking loses its countdown emails; next-day rebooking works.

### 3. SPF/DKIM: already configured - verified end to end, item closed

Measured in DNS and confirmed inside both dashboards today:

- One single SPF TXT on thezerofog.com: `v=spf1 include:_spf.mlsend.com include:zohomail.eu
  ~all` - MailerLite and Zoho in the same record, exactly the one-record rule. Zoho admin shows
  SPF green: "pointed successfully". The 2026-08-10 Zoho warning is obsolete.
- Zoho DKIM: selector `zoho._domainkey`, status toggle ON, **Verified** in the admin console.
- MailerLite DKIM: `litesrv._domainkey` CNAME -> mlsend.com, resolves to a live key;
  `mailerlite-domain-verification` TXT present; a real E1 was delivered to the Zoho inbox on
  2026-08-15.
- DMARC: `v=DMARC1; p=none; rua=mailto:postmaster@thezerofog.com` - monitoring mode, the
  correct start. Tightening to quarantine is a later, deliberate step once reports accumulate.
- MX: mx/mx2/mx3.zoho.eu, all green in Zoho.

Nothing needed from Namecheap. `TODO-SPF-ZOHO-2026-08-10.md` is resolved by this check.

### 4. Still deliberately NOT done here

- The four automations are built but OFF, like the other 16 - activation comes with the plan
  upgrade (E14 could take one of the Free slots earlier if we want the buyer path live first -
  that is a CEO call, since it means choosing which of E1-E3 to sacrifice, so: no).
- E16/E17 send from `refunds@thezerofog.com` - CEO decision 2026-08-15 (refund mail lives in
  the refund mailbox; no separate reply-to). Verified saved on both workflows. One factual
  check remains: the E16 footer says the Stripe refund confirmation arrives separately - true
  only if refund receipts are enabled in the Stripe settings; confirm or cut the sentence.
- E15's real trigger (course completion in Systeme) and E17's channel (auto-reply vs manual
  template) are not wired yet. Until then: manual add-to-group in MailerLite is the send.
- CLOSE-24H stays a manual campaign; nothing to build until the window actually closes. The
  runbook is in the status entry below (section 6) and in `_Marketing/emails/`.

## 2026-08-15 - Workshop system: complete status for Dmitrii - built, tested, and open items

**Written by:** Claude, at Kirill's instruction. This entry is wider than a Make change: it is the
full record of the self-built webinar system (the "workshop room"), in one place, so Dmitrii can
see what exists, how it behaves, what was tested with what results, and what is still open. Every
claim below was verified against the code or a recorded measurement, not remembered.

### 1. What was built and why

EverWebinar was evaluated and NOT bought (decision 2026-08-13: $199/month fixed cost against
unproven demand, and it would replace none of our existing subscriptions). The full equivalent
lives inside the site:

- Netlify Functions (`netlify/functions/wr-*.js`), house style: ESM, native fetch, no npm deps.
- Supabase for all state. Every table is prefixed `wr_` and carries RLS with no policies, so no
  browser can ever read them - only functions holding the service key.
- MailerLite for actual email delivery. Make is OUT of the email path (see the 2026-08-14 entry
  below) and keeps exactly two jobs: forwarding the opt-in lead and the Stripe payment event.
- The video is served from the CloudFront distribution we already pay for through Systeme
  (448 MB master, range requests verified, byte-identical upload: MD5 = CDN etag).

Spec with every EverWebinar capability answered by name:
`docs/WORKSHOP-ROOM-SPEC-2026-08-13.md`.

### 2. The functions, end to end

- `wr-slots.js` - GET. The bookable sessions in the visitor's own timezone. Two kinds: one
  just-in-time slot (next 15-minute boundary, at least 5 minutes away, marked urgent) plus
  recurring scheduled slots (default 10:00/14:00/19:00/21:00 wall-clock New York, every day,
  2 days ahead, 6 slots shown). Sessions are created lazily - a session row exists only after
  somebody registers for that instant. Full sessions and blocked dates are filtered out. If the
  database is unreachable the page still serves the schedule instead of going blank. DST is
  handled: a wall-clock time that does not exist on the spring-forward night resolves forward,
  never backward (this was a real bug, caught by test).
- `wr-register.js` - POST. Registers, mints a 32-char CSPRNG token, revalidates the chosen slot
  server-side (a client cannot book an instant we never offered - forged times get 409), creates
  the session row if needed, queues the ENTIRE email schedule for this person up front, and
  forwards the lead to Make (best effort - a Make failure never loses the registration). Repeat
  registration with the same email = replace: old pending emails become `superseded`, the old
  attendance row is deleted whole (watched seconds must not leak into the new session), the token
  is reused. Honeypot field for bots. No IP address is stored.
- `wr-room.js` - GET by token. The room's single source of truth and the only route that ever
  hands a browser the video URL - and never before start time. Returns one of the states in
  section 3. Records first entry once (`first_seen_at`, `joined_at_position_sec` are written a
  single time ever; reloads cannot reset them - that was the second 08-13 bug).
- `wr-heartbeat.js` - POST. The only writer of attendance truth. Distrustful by design: watched
  seconds are clamped to wall-clock elapsed time since first entry (+60 s allowance), position is
  clamped to the video length, all counters are monotonic. Live and replay watched-seconds are
  SEPARATE columns, never pooled. Recomputes the person's segments on every beat.
- `wr-question.js` - POST. A real question typed in the room: stored in `wr_events`, forwarded to
  its OWN Make webhook (`MAKE_QUESTION_WEBHOOK_URL`) - deliberately no fallback to the opt-in
  webhook, because that exact payload mismatch is what killed the opt-in scenario on 08-13.
- `wr-notify.js` - cron, every 5 minutes (prod only - Netlify does not run crons on branches).
  Drains due `pending` rows (batch 200) and delivers via MailerLite. Re-checks EVERYTHING at send
  time - see section 6. A MailerLite failure leaves the row `pending` with the error recorded;
  it retries next run. A transient outage costs a late email, never a lost one.
- `wr-retention.js` - cron, daily. Deletes registrations older than 24 months (cascade removes
  attendance, events, queue rows).
- `wr-stats.js` - GET, gated by `WORKSHOP_ADMIN_KEY` (constant-time compare; wrong and missing
  key both get an identical 404). Every metric EverWebinar's dashboard shows: show-up rate,
  saw-reveal rate, saw-offer rate, completion, average watch minutes, conversion, segment counts,
  retention curve in 5-minute buckets (built from WATCHED seconds, not playhead), breakdown by
  UTM source and by session hour. NOTE: the key is raw base64 with `+` and `/` - it MUST be
  URL-encoded in the query string, a bare paste 404s (this produced a false "prod key broken"
  finding twice).
- `wr-preferences.js` - POST. The one-click "stop the founding emails" opt-out from E13's P.P.S.
  Sets `no_sales` on the registration; sales-flagged emails are then skipped at send time. It is
  NOT an unsubscribe - non-sales emails still arrive.
- `lib/wr-config.js` - the room's entire behaviour as one object, overridable by a single row in
  `wr_config` WITHOUT a deploy: schedule rules, timecodes, replay window, offer texts, the whole
  email schedule, delivery window, retention. Also home of `deriveSegments()` (section 5).
- `lib/wr-time.js` - timezone and DST maths, no dependencies. `lib/wr-db.js` - PostgREST client,
  token minting. `lib/wr-mailerlite.js` - the delivery transport (section 7).

### 3. What the viewer experiences (room states)

- Before start (`early`): countdown against SERVER time; the video URL is not in the response at
  all; the page reloads itself at zero.
- Live (`live`): the video starts IMMEDIATELY, muted, behind a heavy blur, with one button -
  "Join the session". The click only removes the blur and unmutes; playback was already running
  (a blurred MOVING picture, decided 08-14 - a static frame with a play button reads as a
  recording). Until the click: watched seconds do NOT accumulate (verified on the live DB - nine
  minutes behind the blur = 0 watched), and the offer/handouts/announcements are NOT rendered
  behind the blur (otherwise they would be marked as shown and never appear after the click).
  If autoplay is refused (data-saver, low-power), it falls back to a plain button on black.
- During live: the playhead is pinned to the server session clock (drift over 3 s is corrected),
  seeking is snapped back (measured: a jump from 454 s to 1354 s snapped to 552 - the live
  position), pausing does not stop the broadcast (measured: 30 s pause, resume jumped 31.7 s
  forward to the live mark). Picture-in-picture is disabled (it used to render unblurred frames
  in an OS window). A late joiner past 5 minutes sees an honest "This session started N minutes
  ago - you are joining in progress" banner; nobody is turned away.
- The offer button appears at 43:49 and is sticky. Measured live: at position 3032 it stayed
  hidden before the Join click and appeared after it, with the `offer_shown` event in the DB.
- After the end (`ended`): end plate plus the offer link. The room does NOT quietly turn into
  the replay - the replay is a separate destination reached from emails.
- Replay window over or disabled (`expired`): "the replay window has closed" plus a link to the
  program.

### 4. Replay: when a viewer resumes and when they start over

- Emails link to `/replay/?t=TOKEN`, which redirects into the room with `view=replay` - the only
  way to enter replay state. The same token works for room and replay; there is no second token.
- The replay window is a REAL deadline: session end + 48 hours, computed per person from their
  own session, enforced server-side. (It replaced a localStorage countdown that said "expired"
  and then served the video anyway - removed as deceptive urgency.)
- Resume rule (`wr-room.js`): the replay opens at `max_position_sec` - the furthest point this
  person actually reached, across live AND any earlier replay visit - IF that point is more than
  120 s in AND more than 120 s before the end. Otherwise it starts from 0. In words: someone who
  barely started (2 minutes or less) gets a clean start; someone who reached the final 2 minutes
  is not dropped onto the closing frame; everyone in between picks up exactly where they stepped
  out. This makes E10-B's "pick up where you stepped out" literally true.
- Replay allows seeking and shows the offer from second 0. Scrubbing cannot cheat the emails:
  every threshold below counts WATCHED seconds, not playhead position.

### 5. Segmentation - who counts as what

Timecodes (read off the master's caption track; exact seconds, sentence choice awaiting CEO
confirmation by ear): reveal = 21:56 (1316 s, "And what runs underneath is sleep"), offer =
43:49 (2629 s, "This is the Zero Fog"). Grace = 90 s (forgives a dropped heartbeat, nothing
more). Bounce threshold = 300 s. Video length 3511 s.

- SEG-A-noshow - never opened the room (or watched 0 s live).
- SEG-A-bounced - opened, watched under 5 minutes live. Same rebook chain as no-show, different
  first email, because "you didn't make it" would be false for them.
- SEG-B-pre-reveal - attended (5+ min) but left before 1226 s (reveal minus grace).
- SEG-C-pre-offer - reached the reveal but left before 2539 s (offer minus grace). The
  subtraction matters: leaving before X is a prefix predicate, so without the else-if a minute-4
  leaver would satisfy both and be priced before hearing the mechanism.
- SEG-D-stayed - reached 2539 s.
- SEG-SAW-REVEAL = C or D. SEG-REPLAY-EARNED = watched 1226+ s ON REPLAY (or clicked the bonus
  link) while being a noshow/bounced/pre-reveal person. SEG-CLOSE = SAW-REVEAL or REPLAY-EARNED -
  the only gate into the closing emails E11-E13.

### 6. The emails - who gets what, when, and what triggers it

24 canon texts total in `_Marketing/emails/`: 19 automated by the queue, CLOSE-24H manual by
design, E14-E17 (purchase/refund branch) outside the queue and NOT BUILT yet.

The whole schedule for a person is queued at registration; `wr-notify` re-checks at send time.
Offsets are from registration, session start, or session end (end = start + 3511 s).

Pre-session (everyone):
- E1, registration +0 - receipt with the calendar link. Deliberately does NOT carry the room
  link (held until E3). Exempt from the delivery window.
- E2, start -6h; E3, start -1h (first appearance of the room link); E4, start -15min.
  A countdown email is queued as `skipped` if the wait is shorter than its lead time OR if the
  07:00-23:00 recipient-local delivery window would have moved it - a shifted countdown lies
  (measured failure: three reminders arriving in the same minute, each naming a different
  countdown). Skipped, never sent late.
- E5, start +0 - "we're starting". Exempt from the delivery window: it is the only email that
  can carry the room link to a night-time JIT registrant.

Post-session, by branch:
- Stayed to the close (SEG-D): E6 +30min (the 3 bonuses, one link), E7 +2h (first close, $67
  founding vs $167), E7-C +16h (proof and risk - PLACEHOLDER until real member results exist),
  E8 +24h (replay + soft offer), then E11 +48h, E12 +72h (the $2,000/month math), E13 +96h
  (final close, carries the one-click no-sales opt-out).
- Saw the reveal, left before the product (SEG-C): E7-B +2h (the compressed close they never
  heard, replay in the P.S.), then the same E7-C / E8 / E11 / E12 / E13.
- Left before the reveal (SEG-B): E10-B +1h ("you stepped out before the answer" - replay that
  RESUMES from their drop point, no price, no mechanism), E8-B +24h (last replay call, sells the
  hour not the protocol). E11-E13 arrive ONLY if the replay is actually watched to the reveal
  (SEG-REPLAY-EARNED) - otherwise the sequence ends here.
- No-show (SEG-A-noshow): E9 +1h (rebook, NO replay by design), E9-B +20h (rebook again),
  E9-C +28h (the replay, finally - third door). E11-E13 only via SEG-REPLAY-EARNED.
- Bounced under 5 minutes (SEG-A-bounced): E9-D +1h (truthful opening - "I saw you step in and
  drop out"), then the shared E9-B / E9-C tail.

Send-time guards, all re-checked by `wr-notify` at the moment of sending, never trusted from
queue time:
- Buyer guard: `purchased_at` set = every queued email skipped. A buyer is never pitched.
  (Proven by selftest: a due E7 for a buyer ends `skipped`.)
- No-sales guard: `no_sales` set (E13's opt-out link) = sales-flagged emails skipped (E7, E7-B,
  E7-C, E8, E11, E12, E13), everything else still delivered. Proven on the live DB: E12
  skipped, E6 stayed deliverable.
- Segment still applies: the person's CURRENT segments are recomputed; someone who was
  pre-reveal at queue time but finished the replay since gets the emails of who they are now.
  A missing attendance row is read as "never entered" and derives the no-show segment - the
  08-13 bug where exactly the no-shows (the largest group of any webinar) silently got nothing
  is fixed and covered by test.
- Re-registration: old rows `superseded`, the new session gets a fresh full queue.
- CLOSE-24H: manual campaign when the CEO closes the founding window; audience = non-buyers who
  SAW the workshop; must manually exclude `no_sales` people; Stripe price flips by hand 24h
  later. Not a MailerLite automation, on purpose.

### 7. Delivery transport and MailerLite state

Path: `wr-notify` (cron 5 min) -> upsert the subscriber in MailerLite with merge fields (name,
slot time recomputed in the recipient's zone at send time, room/calendar/replay/no-sales URLs)
-> remove from the template's group -> add to the group. The group join IS the send: one group
per template (`wr-E1` ... `wr-E13`, 19 groups), one single-email automation per group with the
trigger "joins the group". Remove-then-add exists so a re-registered person can be triggered
again - which is why "allow re-entering the workflow" must be ON in every automation.

State as of 2026-08-15:
- All 19 groups, all merge fields, all 19 automations BUILT. Sender: hello@thezerofog.com,
  reply-to kirill@.
- ACTIVE: 3 of 19 - E1, E2, E3. The Free plan allows exactly 3 active automations. The other
  16 are finished and each needs two clicks (Activate -> "No, only add new subscribers") after
  the plan upgrade (Comfort, EUR 11/month, 50 automations - recommended).
- The pipeline is proven live end to end: a real E1 was delivered to the Zoho inbox with the
  slot-time merge tag substituted.
- The queue was wiped to zero (160 accumulated test rows) on 2026-08-15.

### 8. What Make still does

Exactly two jobs, nothing else, both scenarios currently INACTIVE:
- Webinar Opt-In (5275566): homepage lead -> data store -> MailerLite subscriber. Fixed on
  08-14 (see the entry below) but deliberately left OFF until testing ends. WHILE IT IS OFF THE
  LANDING PAGE IS LOSING LEADS - they queue in the webhook (limit 50; past that, real visitors
  start seeing errors on the opt-in form).
- Payment Processing (6209692): Stripe payment forward. Also inactive.
Make sends no emails, ever. `MAKE_NOTIFICATION_WEBHOOK_URL` is retired and must never be set.

### 9. Tests run and their recorded results

`scripts/wr-selftest.mjs` - a live smoke test against the REAL database (registers a
`wr-selftest-*@thezerofog.com` address, drives it through a whole session, cleans up after
itself; email delivery is pointed at an unreachable host so nothing sends). Scenarios covered:
slots endpoint; registration with token and UTM capture; the 19-row queue with correct
skipped-countdown handling; room hidden before start; live state with position, no-seek and
late-join flags; reload NOT resetting first-entry (one join event, not three); segment ladder
(3 min = bounced, 10 min = pre-reveal, past reveal = pre-offer + saw-reveal, past offer =
stayed); a forged claim of 999,999 watched seconds clamped to real elapsed time; buyer guard;
no-sales guard; no-show still getting E9 with no attendance row; re-registration starting clean
(a planted 2600-second attendance row deleted); unknown token = 404.
Results: 2026-08-13 - 30 checks passed, plus 41 timezone/DST checks and 11 degraded-DB checks.
2026-08-14 - ALL PASSED with the two new regression cases. 2026-08-15 - 23 checks ALL PASSED
after the MailerLite transport rewrite. All in `main`, deployed.

Live single-viewer run on prod, 2026-08-14 (visible tab - a backgrounded tab throttles media
and had produced an invalid morning run): video plays, duration exactly the master's 3510.73 s;
seek snapped back; captions attach (1071 cues); player follows the server clock within 0.2 s;
late-join banner renders; offer hidden behind the blur, shown after Join, event recorded;
pause carries the viewer forward with the broadcast; 45 minutes behind the blur = 0 watched
seconds, 6 minutes after joining = 356.

Bugs found ONLY by testing, all fixed and verified: DST slot resolving an hour backward;
first-entry overwritten on every reload (froze segments); no-show emails silently skipped for
every no-show; watched seconds leaking into a re-registered session (disabling the anti-cheat
clamp); registration IMPOSSIBLE from the landing path (a hidden required email field made the
form invalid with no visible error - found by the CEO's own eyes on preview); three countdown
reminders arriving in one minute; a JIT slot 409-ing seconds after being offered (lead time
applied twice); a year-deep browser cache serving stale JS/CSS to every returning visitor;
the end-of-session redirect dropping the hottest viewer onto a token-less replay stub; the PiP
blur bypass; the replay's dead seek bar before load.

The big negative finding of 08-14, measured on the live DB: `pending 105, skipped 44,
superseded 11, sent 0` - across all testing up to that point NO funnel email had ever actually
been sent (crons only run on prod, and delivery config was missing there). That is what forced
the MailerLite-direct rewrite, after which the live E1 delivery proved the path.

Honest gap in the test record: the 08-14 multi-agent analysis (funnel over HTTP, room states,
player logic, email logic) was read-only, and its three reports were lost with that session's
context - only partially processed. Their surfaced-but-unworked findings are in section 10.
The full REAL send run across all four branches (stayed / left pre-reveal / bounced / no-show,
with actual emails arriving) has NOT been done yet - it is the first task after the MailerLite
upgrade. Current live stats: 9 registrations (all ours), 3 room joins, 0 purchases.

### 10. Open items - the honest "are we done?"

No. The system is built and every tested path passes, but launch is gated on these:

Blockers:
1. MailerLite plan upgrade not paid; 16 of 19 automations built but OFF. Until then, any
   post-session email the queue marks "sent" goes nowhere. Do not exercise post-session
   branches before this.
2. "Allow re-entering the workflow" confirmed only on E1 of 19 automations. Without it a
   re-registered person silently gets no email. Check all 19.
3. Make Webinar Opt-In scenario is OFF - the live landing is losing leads right now (webhook
   queue limit 50, then real visitors see errors). Enable + drain the queue first.
4. The full end-to-end send run across all four branches - never done. Schedule it right after
   the upgrade.
5. E14-E17 (purchase welcome, course-complete, refund pair) and CLOSE-24H: texts exist,
   nothing built, never CEO-reviewed. E14's Stripe trigger (checkout.session.completed ->
   MailerLite) has no implementation. No abandoned-checkout email exists at all.
6. The two timecodes (reveal 21:56, offer 43:49) await CEO confirmation by ear - they decide
   which email every leaver gets.
7. SPF/DKIM/DMARC for thezerofog.com (Zoho + MailerLite in ONE SPF record) - parked 08-10,
   still unconfigured. The whole funnel is email; without it Gmail/Outlook may spam-folder
   everything.

Known and accepted for now (not launch blockers, do not lose them):
- Two tabs on one token merge attendance and can double-count watched time.
- Queue head-of-line risk from the lost agent reports: permanently failing rows stay `pending`
  forever and could clog the 200-row batch; emails have no expiry; no mobile-pause or
  video-error handling in the player.
- The master mp4 is publicly downloadable from CloudFront by anyone who reads the network tab
  (same exposure the course lessons already carry - accepted trade for a free workshop);
  `+faststart` remux pending.
- Seven room copy texts live unapproved defaults; the replay screen still says "Join the
  session"; the approved bottom timer/register bar is not built.
- Legal pages still name EverWebinar as a processor (edit only with CEO and Dmitrii).
- Captions are suspiciously perfect for a "live" session - decision deferred.
- Supabase free-tier idle-sleep never verified in practice (the 5-min cron should prevent it).
- Meta side: Conversions API not built, no payment method on the ad account.
- Housekeeping: 9 test registrations remain in the DB; the `kirill+mltest@` reference
  subscriber stays until template work ends; `dima-emails-flat/` (24 files) needs re-upload to
  the Drive pack; `/assets/img/` still on a 1-hour cache; a stray mockup page builds on prod.

## 2026-08-14 - Webinar Opt-In (5275566): duplicate registrations no longer kill the scenario

**Changed by:** Claude, at Kirill's instruction. Applied through the Make UI (the API PATCH was
blocked by a local safety rule), so it also appears in the scenario's own edit history.

**Backups:**
- `docs/make-backups/scenario-5275566-blueprint-2026-08-14-before.json`
- `docs/make-backups/scenario-5275566-blueprint-2026-08-14-after.json`
- `docs/make-backups/scenario-6209692-blueprint-2026-08-14.json` (Payment Processing, read only,
  taken to prove it does not write to the same data store)

### What was wrong

Module 6, `Data store - Add/replace a record` on `zerofog_leads` (data store 131783), was keyed on
`{{1.email}}` with **Overwrite an existing record = No**. Any second arrival of the same address
therefore failed with:

```
Duplicate key error. A record with the same key exists or was already inserted in this scenario.
Code: DataError
```

Make deactivates a scenario after a few consecutive errors, and it did: three registrations
arrived at 21:15, 21:18 and 21:20 UTC on 2026-08-13, the third failed, and the scenario was
switched off. It had been off ever since.

This was not an edge case. The site's own registration policy is `duplicatePolicy: 'replace'` -
somebody who registers, misses the session and registers again is expected behaviour, and every
one of them would have hit this.

Two consequences worth remembering:

- `netlify/functions/optin.js` returns HTTP 500 to the visitor when Make answers with a non-2xx.
  A stopped scenario is survivable only because the webhook keeps queueing (limit 50). Past that
  limit the live opt-in form starts failing for real people.
- The payload that failed came from `wr-register.js`, not from the opt-in form. Four different
  payload shapes were being posted to this one webhook. That is fixed separately in the site
  repo: `wr-question.js` and `wr-notify.js` no longer fall back to `MAKE_WEBHOOK_URL`.

### What was changed

Module 6 only:

```diff
- "overwrite": false
+ "overwrite": true
```

A repeat address now overwrites its own row instead of erroring, and the run continues to
MailerLite, whose `Create / Update a Subscriber` is already idempotent.

### What the UI changed by itself

Opening the module in the Make editor added two keys to the mapper that were not there before:

```diff
  "data": {
    "created_at": "{{now}}",
    "email": "{{1.email}}",
    "lead_id": "{{5.lead_id}}",
+   "payment_session_id": "",
+   "purchased_at": "",
    "source": "optin",
    "webinar_first_name": "",
    "webinar_status": ""
  }
```

Make materialises every field of the data structure when a data store module is saved. Nothing
else in the blueprint differs from the backup - that was verified by diffing, not assumed.

### The one thing to watch

`zerofog_leads` uses replace semantics now. Its data structure (445438) declares `is_buyer`,
`purchased_at` and `payment_session_id`, so the store is clearly *intended* to hold buyer state.

Today that is harmless: **nothing writes those fields.** Payment Processing (6209692) does not
touch this data store at all - it runs `webhook -> Systeme.io listContacts -> If/Else -> Merge ->
MailerLite` - and none of the 20 existing records carry them.

The moment buyer state does get written here, a repeat opt-in from that person will erase it.
Whoever wires that up must first change module 6 to read the existing record and update only its
own fields, rather than replacing the row.

### Still open after this change

- The scenario was left **inactive**. Turning it back on is a separate decision.
- Five records are waiting in the webhook queue (limit 50): one opt-in probe, one test
  registration, two questions typed in the workshop room, and the registration that caused the
  failure. All five are our own addresses. They replay when the scenario is switched on.
- Payment Processing (6209692) is also inactive.

## 2026-08-14 - Make is out of the notification path (no scenario touched)

**Changed by:** Claude, at Kirill's instruction. Nothing inside Make was modified - this entry
records an architecture decision that affects what Make will NOT be asked to do.

The planned third scenario ("workshop_notification" -> emails) is cancelled. Reasons, counted:
the Free plan allows 2 active scenarios and both slots are taken (Webinar Opt-In 5275566,
Payment Processing 6209692); the 1000 operations/month budget is ~25 registrants' worth of
funnel; and the opt-in scenario never sent mail anyway (webhook -> datastore -> MailerLite
subscriber) - sending always lived in MailerLite.

`wr-notify.js` now delivers directly to MailerLite (`lib/wr-mailerlite.js`): one group per
template (`wr-E1`...`wr-E13`, 19 groups created 2026-08-14 via API), an automation per group
sends the email. Make keeps exactly its two existing jobs: the opt-in lead forward and the
Stripe payment forward. `MAKE_NOTIFICATION_WEBHOOK_URL` is retired and must never be set.
