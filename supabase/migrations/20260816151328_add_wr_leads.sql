-- ============================================================================
-- wr_leads. Moved out of supabase/drafts/ on 2026-08-16 on the owner's word,
-- to be applied with `supabase db push`.
-- ============================================================================
--
-- WHAT THIS SUPPORTS
--
-- The landing-page opt-in stops going through Make.com. `netlify/functions/optin.js`
-- used to POST the address to a Make webhook, whose scenario wrote it into a Make data
-- store and created a MailerLite subscriber. Make is being removed from that path: the
-- function now writes the lead here and adds the subscriber to MailerLite itself.
--
-- This table IS the replacement for the Make data store - the copy of the lead that
-- lives in our own stack, captured BEFORE the visitor reaches the schedule step. Anyone
-- who drops between the form and picking a session exists only here.
--
-- CODE CONTRACT
--
-- Changed function: netlify/functions/optin.js (handler) - it now calls
-- `upsert()` from netlify/functions/lib/wr-db.js instead of fetching MAKE_WEBHOOK_URL.
--
-- Table touched: public.wr_leads. Columns the code writes on every opt-in:
--   email       text  - lowercased, trimmed. THE CONFLICT KEY.
--   name        text  - optional, absent when the form did not collect it
--   source      text  - always 'optin' today; the column exists so a second capture
--                       point does not need a migration
--   data        jsonb - {utm: {...}, referrer}, both optional and the key is omitted from
--                       the write entirely when empty, so a second opt-in cannot blank what
--                       the first one recorded. The landing form does not send utm today
--                       (it appends the params to the redirect instead) - the handler reads
--                       it if a future client does, and always records the referer header.
--   created_at  timestamptz - default now(), never written by the code
--   updated_at  timestamptz - written on every upsert so a returning visitor is visible
--
-- The code reads nothing back. `upsert(..., 'email', {returning:false})` relies on a
-- UNIQUE constraint on email - that is the conflict key.
--
-- NOTE TO THE OWNER
--
-- Same RLS model as the rest of the wr_* tables and for the same reason: a lead is an
-- anonymous address, not an app account, so there is no user_id and nothing to cascade
-- from auth.users. RLS on, no policies, grants to service_role only - the table is
-- reachable only by a function holding SUPABASE_SECRET_KEY.
--
-- Nothing here touches an existing table. Until this is applied, optin.js still answers
-- the visitor normally and still creates the MailerLite subscriber - the Supabase write
-- fails, gets logged, and the lead is not lost. So applying it is not a release gate,
-- it is what turns the second copy on.

create table if not exists "public"."wr_leads" (
  "id"         uuid primary key default gen_random_uuid(),
  "email"      text not null unique,
  "name"       text,
  "source"     text,
  "data"       jsonb not null default '{}'::jsonb,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create index if not exists "wr_leads_created_idx"
  on "public"."wr_leads" ("created_at" desc);

alter table if exists "public"."wr_leads" enable row level security;

-- --------------------------------------------------------------- grants ----
-- service_role only. anon and authenticated are intentionally omitted.
grant all on table "public"."wr_leads" to "service_role";
