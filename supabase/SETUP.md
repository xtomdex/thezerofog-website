# Supabase setup — manual dashboard steps

These are the one-time steps a human performs in the Supabase dashboard. The
database structure itself lives in [`migrations/`](./migrations/) and is applied
with `supabase db push`; everything below is the manual dashboard configuration
around it.

## 1. Create a Supabase project

Free tier is sufficient for now (500 MB database, 50k monthly active users).

## 2. Apply the database structure

The schema is managed as Supabase CLI migrations in [`migrations/`](./migrations/).
Apply them to the linked project with:

```
supabase db push
```

The baseline migration creates `profiles`, `diary_entries`, `assessments`, the
`is_paid_user()` helper, the `rls_auto_enable` event trigger, and all RLS policies;
later migrations add `protocol_cards` and `recovery_protocol_cards`. Migrations are
applied by whoever owns DB pushes — do not paste SQL into the SQL Editor by hand.

## 3. Enable email OTP as a numeric code (critical — not the default)

The app uses a 6-digit one-time code (`verifyOtp({ type: 'email' })`), **not** a
magic link. Supabase defaults to a magic link, so this must be reconfigured:

- **Authentication → Providers → Email**: ensure the Email provider is enabled.
- **By default `signInWithOtp` sends a magic LINK, not a code.** To force a
  6-digit code, go to **Authentication → Email Templates → Magic Link** and
  replace `{{ .ConfirmationURL }}` with `{{ .Token }}` so the email delivers the
  numeric token. Without this, the user never receives a code and the app's
  `verifyOtp` flow cannot work.
- **Confirm the OTP length is 6** in the Email provider settings. Some projects
  default to 8; the app's code input expects 6 digits. Keep it at 6.
- **Do not rely on `emailRedirectTo`** in the client call. Leaving it out keeps
  Supabase in code-delivery (OTP) mode rather than switching to a link flow.
  (This is enforced in a later app-code prompt; noted here for awareness.)

## 4. Grab the keys (Settings → API)

| Key | Visibility | Used by |
|---|---|---|
| **Project URL** | Public | Browser client |
| **anon public key** | Public (RLS protects the data) | Browser client |
| **service_role key** | **SECRET — server-only** | Netlify Functions (later prompts) |

> The **service_role key bypasses RLS**. Never place it anywhere client-side,
> never commit it, never expose it via `_data/`. It belongs only in server-side
> Netlify Function environment variables (set in later prompts).

## 5. Email sending (pre-launch, not blocking dev)

Supabase's built-in mailer is rate-limited and intended for development only.
For development/testing it is fine. **Before real users**, configure a custom
SMTP provider (e.g. Resend / SendGrid / Postmark) on the project's own domain
(`thezerofog.com`) so OTP emails send reliably and don't hit rate limits or land
in spam.
