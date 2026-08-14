-- Adds the one-click opt-out from the SALES cadence promised in E13's P.P.S.
-- ("one click here and I stop. You'll still get the useful stuff, just nothing about the price.")
--
-- The flag lives on the registration, not in MailerLite: our own queue (wr-notify) owns
-- segmentation, so the exclusion has to live where the sending decision is made. Templates
-- flagged `sales: true` in wr-config's schedule are skipped for a registration with
-- no_sales = true; the manual CLOSE-24H blast must honour the same flag.
--
-- Set by netlify/functions/wr-preferences.js via the /no-thanks/?t= page. Never unset by
-- code - if someone re-registers, duplicatePolicy 'replace' creates a fresh registration row
-- and the flag starts clean, which matches the promise being per-registration consent.

alter table wr_registrations
  add column if not exists no_sales boolean not null default false;

-- APPLIED 2026-08-14 via the Supabase Management API (SUPABASE_ACCESS_TOKEN in .env), not db push.
-- Idempotent (if not exists), so a later `supabase db push` replaying it is harmless.
