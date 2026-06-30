# Data-subject requests — internal runbook

How we handle data-subject requests for the `/app` sleep tools, which store health-adjacent
personal data (sleep times, alcohol/caffeine/sleep-aid use, assessment answers) tied to a user's
email. This is the operational protocol referenced by the Privacy Policy. Keep it practical — it's
a runbook, not legal prose.

Data lives in Supabase: `profiles`, `diary_entries`, `assessments`, all keyed by `user_id`
(`auth.users.id`). `profiles.user_id`, `diary_entries.user_id`, and `assessments.user_id` all
`on delete cascade`, so removing the auth user removes everything.

## Erasure (Art. 17) — self-service

Implemented in-app via **"Delete my data"** (in the diary view).

- **What it does:** deletes the user's `diary_entries` and `assessments` rows (client-side, allowed
  by RLS for own rows), then calls `netlify/functions/delete-account.js`, which verifies the
  caller's session JWT and deletes their auth user via the Supabase admin API. The auth-user delete
  cascades to `profiles` (and is a backstop for the diary/assessment rows).
- **Irreversible and immediate.** There is no soft-delete or recovery window. After deletion the
  user is signed out and redirected; the account no longer exists.
- **Identity:** the function derives `user_id` from the verified session token only — a user can
  only ever delete their own account. Nothing in the request body is trusted for identity.

## Access / data export (Art. 15) — via support (V1)

No self-service export yet. Procedure:

1. User emails support requesting their data.
2. Verify the requester controls the account email (see Identity verification).
3. Dima retrieves their `profiles`, `diary_entries`, and `assessments` rows from Supabase
   (filtered by their `user_id` / email) and provides them to the user.

This can be automated later (e.g. an authenticated "export my data" endpoint), but is **manual in
V1**.

## Rectification (Art. 16) — partly self-service

- Diary and assessment entries are **user-editable in the app** — users correct their own records
  directly.
- Anything else (e.g. correcting the email tied to the auth account) is handled **via support**.

## Consent withdrawal (Art. 7.3)

Storing the diary/assessment data is the processing the user consented to (at the consent checkbox
on sign-in). Therefore **withdrawing consent = deleting the data** (erasure). Point users to
**"Delete my data."** If finer-grained consent withdrawal (e.g. stop processing but retain) is
needed later, revisit this.

## Identity verification

- **In-app actions** (deletion, rectification): the OTP-authenticated session proves identity. No
  extra check needed.
- **Support-handled requests** (export, email correction): verify the requester actually controls
  the account email before acting — e.g. require the request to come from that email address, or
  confirm via a reply to that address.

## Privacy policy coverage (required)

The privacy page (`src/privacy.njk`) must list, for the `/app` data:

- **What data is collected** — sleep times, lifestyle factors (alcohol/caffeine/naps/exercise/sleep
  aids), sleep quality, notes, assessment answers, email.
- **Purpose** — to provide the sleep-tracking app (store and show the user's own entries).
- **Legal basis** — consent (captured at sign-in).
- **Retention** — kept until the user deletes their account; deletion is immediate and irreversible.
- **Subject rights + how to invoke them** — in-app "Delete my data" for erasure/consent withdrawal;
  support contact for access/export and rectification.

Copy is Dima/Kirill's responsibility; this section only states what the policy must cover.
