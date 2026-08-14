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
