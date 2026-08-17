-- ============================================================================
-- service_events. Added 2026-08-17.
-- ============================================================================
--
-- WHAT THIS SUPPORTS
--
-- Proof that a customer actually received the service. Today we cannot produce it:
-- `auth.users.last_sign_in_at` is a single overwritten timestamp, not a history, and
-- Systeme's public API exposes no progress at all (probed 2026-08-17: every plausible
-- progress endpoint 404s, and the enrolment object carries only id/contact/course/
-- accessType/active). So if a buyer files a chargeback claiming they never got
-- anything, we have nothing to show.
--
-- WHY NOT POSTHOG
--
-- PostHog is already live on the site and inside the course area, and it must stay
-- what it is: analytics, gated on cookie consent. Evidence of delivery cannot live
-- behind a consent gate - for a customer who declined there would be nothing at all,
-- and anyone clearing their browser breaks the thread. Precisely in the case where it
-- matters, it is empty. This table is a record of contract performance, not analytics,
-- and is written regardless of the analytics choice.
--
-- FORGEABILITY, AND WHY THE TWO SOURCES DIFFER
--
-- 'app' events are written by a Netlify function that verifies the caller's Supabase
-- JWT and takes the identity from the verified response, never from the body - the
-- same rule delete-account.js already follows. Those rows are trustworthy.
--
-- 'course' events come from our script embedded in Systeme's student area, where we
-- have no token of ours to verify. That data is the browser's word. It is accepted
-- anyway because the threat model is inverted: the only lie available is "I used it
-- MORE", which argues against the person's own refund claim, not for it. Nobody
-- fabricates evidence that they consumed the product they want their money back for.
--
-- CODE CONTRACT
--
--   user_id  uuid  - our Supabase auth user, when known. Null for 'course' rows,
--                    where Systeme's ids are a different namespace from ours.
--   email    text  - lowercased. THE JOIN KEY between the app, Systeme and Stripe.
--                    Null on a course row until the Systeme-side address question is
--                    settled with a real test student (see the note below).
--   source   text  - 'app' | 'course'
--   event    text  - 'sign_in' | 'lesson_view' | 'course_progress'
--   ref      text  - lecture id for a view, course path for progress, null for sign-in
--   data     jsonb - whatever the source can add: completed/total counts, percentage,
--                    the Systeme user id. Deliberately loose so a new signal does not
--                    need a migration.
--
-- No deletion rule is set here. Retention for this log is still open - it is the one
-- record we may need long after the diary content is gone, because disputes run to
-- ~120 days and sometimes further.
--
-- OPEN, AND IT BLOCKS FILLING email ON COURSE ROWS
--
-- Systeme's /api/user/user-data does return an address, but the only account we could
-- inspect belongs to a person who is both the site owner and an enrolled student, so
-- we cannot yet tell whether that field is the student's or the school account's. If
-- it is the school's, every course row would carry our own address. Until one real
-- test student settles it, course rows carry the Systeme user id in `data` and leave
-- `email` null.
--
-- SAFE TO APPLY EARLY. Nothing reads this table yet and no existing table is touched;
-- applying it only turns the recording on.

create table if not exists "public"."service_events" (
  "id"         uuid primary key default gen_random_uuid(),
  "user_id"    uuid references "auth"."users"("id") on delete set null,
  "email"      text,
  "source"     text not null,
  "event"      text not null,
  "ref"        text,
  "data"       jsonb not null default '{}'::jsonb,
  "created_at" timestamptz not null default now()
);

-- The two questions this table is ever asked: "what did this person do" and
-- "what happened lately". Nothing else is indexed on purpose.
create index if not exists "service_events_email_idx"
  on "public"."service_events" ("email", "created_at" desc);

create index if not exists "service_events_user_idx"
  on "public"."service_events" ("user_id", "created_at" desc);

create index if not exists "service_events_created_idx"
  on "public"."service_events" ("created_at" desc);

alter table if exists "public"."service_events" enable row level security;

-- --------------------------------------------------------------- grants ----
-- service_role only. anon and authenticated are intentionally omitted: a log the
-- subject can write is not evidence of anything.
grant all on table "public"."service_events" to "service_role";
