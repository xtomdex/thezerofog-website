-- ============================================================================
-- DRAFT MIGRATION - workshop room (our own automated-session system)
-- Written 2026-08-13. NOT APPLIED. For the migration owner to verify and apply.
-- ============================================================================
--
-- CODE CONTRACT - what the application code actually does with these tables
-- ----------------------------------------------------------------------------
-- New code, all under thezerofog-website/netlify/functions/:
--   lib/wr-db.js      - PostgREST access using SUPABASE_SECRET_KEY (service role)
--   lib/wr-config.js  - loadConfig(), deriveSegments()
--   lib/wr-time.js    - timezone/slot maths, no database access
--   wr-slots.js       - GET, read-only
--   wr-register.js    - POST, writes sessions/registrations/notifications
--   wr-room.js        - GET, writes attendance + a join event
--   wr-heartbeat.js   - POST, writes attendance + events
--   wr-question.js    - POST, writes an event
--   wr-notify.js      - scheduled every 5 min, reads the queue, updates status
--
-- CHANGED EXISTING CODE:
--   optin.js          - no longer reads EVERWEBINAR_SCHEDULE_URL; returns our own schedule path
--   stripe-webhook.js - now also PATCHes wr_registrations.purchased_at for the paying address,
--                       best effort, and never fails the webhook over it
--
-- Table by table, exactly what the code reads and writes:
--
-- wr_config
--   read : selectOne(key = 'zerofog-workshop') -> data (jsonb)
--   write: none from code. Edited by hand; code falls back to defaults when absent.
--
-- wr_blocked_dates
--   read : select(blocked_on) - wr-slots.js, wr-register.js
--   write: none from code. Edited by hand.
--
-- wr_sessions
--   read : id, starts_at, kind, cap, registrant_count
--   write: insert { starts_at, kind } - wr-register.js ensureSession()
--   CONFLICT KEY: starts_at must be UNIQUE. Two people registering for the same brand-new
--                 slot in the same second both attempt the insert; the code catches the loser's
--                 error and re-reads. Without the unique index it silently creates two sessions.
--
-- wr_registrations
--   read : id, email, name, token, time_zone, session_id, and PostgREST embeds
--          wr_sessions(starts_at,kind) and wr_attendance(...)  -> BOTH EMBEDS NEED REAL FKs
--   write: upsert { webinar_key, session_id, email, name, token, time_zone, consent_at,
--                   consent_text, source, data } on conflict (webinar_key, email)
--   CONFLICT KEY: (webinar_key, email). Re-registering for a different slot must REPLACE, not
--                 duplicate. `token` is also unique - it is the join credential and is looked up
--                 directly by wr-room.js and wr-heartbeat.js.
--   data: jsonb of { utm: { utm_source, utm_medium, utm_campaign, utm_content, utm_term } }
--   NOTE: no IP address is stored anywhere, deliberately.
--
-- wr_notifications
--   read : none yet (wr-notify.js is the next function and will select due rows)
--   write: insert [ { registration_id, template, segments (text[]), scheduled_for, status } ]
--          update status -> 'superseded' where registration_id = X and status = 'pending'
--   status values used by code: 'pending' | 'skipped' | 'superseded' (and 'sent' | 'failed'
--          once wr-notify lands)
--
-- wr_attendance
--   read : first_seen_at, watched_sec, max_position_sec, replay_watched_sec
--   write: upsert { registration_id, first_seen_at, last_seen_at, joined_at_position_sec,
--                   max_position_sec, watched_sec | replay_watched_sec } on conflict
--                 (registration_id)
--          update { segments (text[]), total_watched_sec }
--   CONFLICT KEY: registration_id, and it is the primary key - one attendance row per person.
--
-- wr_events
--   read : none yet (the analytics function will)
--   write: insert { registration_id, type, position_sec, payload }
--   type values: join, offer_shown, offer_click, handout_click, poll_answer,
--                announcement_shown, bonus_click, exit, pause, resume
--
-- ============================================================================
-- NOTE TO THE OWNER - please read before applying
-- ============================================================================
--
-- 1. THIS DEVIATES FROM THE PROJECT'S STANDARD RLS MODEL, ON PURPOSE.
--    Every existing table hangs off auth.users and uses "own row AND is_paid_user()" policies.
--    These tables do not: a workshop registrant is an anonymous lead, not an app account, and
--    has no auth.uid(). There is therefore no user_id column and no cascade from auth.users.
--    RLS is enabled and NO policies are written, which means the tables are unreachable from
--    anon and authenticated alike. The only access is the service key held by the functions.
--    If you would rather these carried explicit deny-policies for documentation value, say so
--    and I will add them - but RLS-on-with-no-policies is already closed, not open.
--
-- 2. GRANTS ARE NARROWER THAN THE EXISTING TABLES. I grant to service_role only, not to anon
--    and authenticated. Those two have no business here and granting them buys nothing. Flagging
--    it because it differs from the baseline pattern you will be comparing against.
--
-- 3. THERE IS ONE TRIGGER. wr_sessions.registrant_count is maintained by a trigger on
--    wr_registrations rather than by the application, because the count is read by the slot
--    endpoint to hide full sessions and an application-side increment would race. It is additive
--    and touches nothing that exists.
--
-- 4. NOTHING HERE TOUCHES AN EXISTING TABLE. No drop, no alter, no rename, no column removal.
--    Every statement is create-if-not-exists on a new name.
--    VERIFIED AGAINST THE LIVE DATABASE 2026-08-13 by the CEO, from the SQL editor:
--      select table_name from information_schema.tables where table_schema = 'public';
--    returned exactly five rows - assessments, diary_entries, profiles, protocol_cards,
--    recovery_protocol_cards. No wr_* table exists, so nothing here collides.
--    (The project is on the free tier and had gone to sleep; the first query timed out and the
--    second woke it. Worth knowing before the room takes live traffic - see note 6.)
--
-- 6. FREE TIER SLEEPS. The project pauses after a period of inactivity, and the first request
--    after that fails rather than waiting. The workshop room cannot take a registration from a
--    sleeping database, and /app is already exposed to the same thing. The tier has to go up
--    before any advertising traffic reaches the funnel.
--
-- 5. citext is deliberately NOT used for email. The application lowercases and trims before
--    every write and read, so a plain text column with a unique constraint is enough and does
--    not require an extension.
--
-- ============================================================================

-- ---------------------------------------------------------------- config ----
create table if not exists "public"."wr_config" (
  "key"        text primary key,
  "data"       jsonb not null default '{}'::jsonb,
  "updated_at" timestamptz not null default now()
);

-- --------------------------------------------------------- blocked dates ----
create table if not exists "public"."wr_blocked_dates" (
  "blocked_on" date primary key,
  "reason"     text,
  "created_at" timestamptz not null default now()
);

-- -------------------------------------------------------------- sessions ----
create table if not exists "public"."wr_sessions" (
  "id"               uuid primary key default gen_random_uuid(),
  "starts_at"        timestamptz not null,
  "kind"             text not null default 'scheduled',
  "cap"              integer,
  "registrant_count" integer not null default 0,
  "created_at"       timestamptz not null default now(),
  constraint "wr_sessions_kind_check" check ("kind" in ('scheduled', 'jit', 'ondemand'))
);

-- The conflict key ensureSession() depends on. See code contract note.
create unique index if not exists "wr_sessions_starts_at_key"
  on "public"."wr_sessions" ("starts_at");

-- --------------------------------------------------------- registrations ----
create table if not exists "public"."wr_registrations" (
  "id"           uuid primary key default gen_random_uuid(),
  "webinar_key"  text not null,
  "session_id"   uuid not null references "public"."wr_sessions" ("id") on delete cascade,
  "email"        text not null,
  "name"         text,
  "token"        text not null,
  "time_zone"    text,
  "consent_at"   timestamptz,
  "consent_text" text,
  "source"       text,
  -- Set by stripe-webhook.js when a paid checkout matches this address. It is the buyer guard
  -- that every sales email in the sequence is gated on, and wr-notify.js reads it immediately
  -- before each send. Stripe remains the only thing that decides who bought.
  "purchased_at" timestamptz,
  "data"         jsonb not null default '{}'::jsonb,
  "created_at"   timestamptz not null default now(),
  "updated_at"   timestamptz not null default now()
);

-- One registration per person per workshop: re-registering replaces the slot.
create unique index if not exists "wr_registrations_webinar_email_key"
  on "public"."wr_registrations" ("webinar_key", "email");

-- The join credential, looked up directly on every room and heartbeat call.
create unique index if not exists "wr_registrations_token_key"
  on "public"."wr_registrations" ("token");

create index if not exists "wr_registrations_session_idx"
  on "public"."wr_registrations" ("session_id");

-- ------------------------------------------------------------ attendance ----
create table if not exists "public"."wr_attendance" (
  "registration_id"        uuid primary key
                             references "public"."wr_registrations" ("id") on delete cascade,
  "first_seen_at"          timestamptz,
  "last_seen_at"           timestamptz,
  "joined_at_position_sec" integer not null default 0,
  "max_position_sec"       integer not null default 0,
  "watched_sec"            integer not null default 0,
  "replay_watched_sec"     integer not null default 0,
  "total_watched_sec"      integer not null default 0,
  "segments"               text[] not null default '{}',
  "ended_reason"           text,
  "device"                 text,
  "updated_at"             timestamptz not null default now()
);

-- Segment membership is queried when the notification cron decides who gets what.
create index if not exists "wr_attendance_segments_idx"
  on "public"."wr_attendance" using gin ("segments");

-- ---------------------------------------------------------------- events ----
create table if not exists "public"."wr_events" (
  "id"              bigserial primary key,
  "registration_id" uuid not null
                      references "public"."wr_registrations" ("id") on delete cascade,
  "type"            text not null,
  "position_sec"    integer,
  "payload"         jsonb,
  "created_at"      timestamptz not null default now()
);

create index if not exists "wr_events_registration_idx"
  on "public"."wr_events" ("registration_id", "created_at");

-- --------------------------------------------------------- notifications ----
create table if not exists "public"."wr_notifications" (
  "id"              bigserial primary key,
  "registration_id" uuid not null
                      references "public"."wr_registrations" ("id") on delete cascade,
  "template"        text not null,
  "segments"        text[] not null default '{}',
  "scheduled_for"   timestamptz not null,
  "status"          text not null default 'pending',
  "sent_at"         timestamptz,
  "error"           text,
  "created_at"      timestamptz not null default now(),
  constraint "wr_notifications_status_check"
    check ("status" in ('pending', 'sent', 'skipped', 'superseded', 'failed'))
);

-- The cron's only query: everything pending whose time has come.
create index if not exists "wr_notifications_due_idx"
  on "public"."wr_notifications" ("status", "scheduled_for");

-- ---------------------------------------------------- registrant counter ----
-- Maintained here rather than in the application because wr-slots.js reads it to hide full
-- sessions, and an application-side increment would race between two simultaneous registrations.
create or replace function "public"."wr_sync_registrant_count"() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT') then
    update public.wr_sessions
       set registrant_count = registrant_count + 1
     where id = new.session_id;
  elsif (tg_op = 'DELETE') then
    update public.wr_sessions
       set registrant_count = greatest(registrant_count - 1, 0)
     where id = old.session_id;
  elsif (tg_op = 'UPDATE' and new.session_id is distinct from old.session_id) then
    update public.wr_sessions
       set registrant_count = greatest(registrant_count - 1, 0)
     where id = old.session_id;
    update public.wr_sessions
       set registrant_count = registrant_count + 1
     where id = new.session_id;
  end if;
  return null;
end;
$$;

drop trigger if exists "wr_registrations_count_trigger" on "public"."wr_registrations";
create trigger "wr_registrations_count_trigger"
  after insert or update or delete on "public"."wr_registrations"
  for each row execute function "public"."wr_sync_registrant_count"();

-- ------------------------------------------------------------------ RLS ----
-- Enabled explicitly, even though the rls_auto_enable event trigger would also catch these.
-- No policies: these tables hold anonymous lead data with no auth.uid() to match against, and
-- the only intended reader is a Netlify Function holding the service key. RLS on with zero
-- policies is closed to anon and authenticated, which is exactly the intent.
alter table if exists "public"."wr_config"        enable row level security;
alter table if exists "public"."wr_blocked_dates" enable row level security;
alter table if exists "public"."wr_sessions"      enable row level security;
alter table if exists "public"."wr_registrations" enable row level security;
alter table if exists "public"."wr_attendance"    enable row level security;
alter table if exists "public"."wr_events"        enable row level security;
alter table if exists "public"."wr_notifications" enable row level security;

-- --------------------------------------------------------------- grants ----
-- service_role only. anon and authenticated are intentionally omitted.
grant all on table "public"."wr_config"        to "service_role";
grant all on table "public"."wr_blocked_dates" to "service_role";
grant all on table "public"."wr_sessions"      to "service_role";
grant all on table "public"."wr_registrations" to "service_role";
grant all on table "public"."wr_attendance"    to "service_role";
grant all on table "public"."wr_events"        to "service_role";
grant all on table "public"."wr_notifications" to "service_role";
grant usage, select on sequence "public"."wr_events_id_seq"        to "service_role";
grant usage, select on sequence "public"."wr_notifications_id_seq" to "service_role";

-- ------------------------------------------------------------ seed row ----
-- Empty on purpose: the application's DEFAULT_CONFIG is the real default, and this row exists
-- only so overrides have somewhere to live.
insert into "public"."wr_config" ("key", "data")
values ('zerofog-workshop', '{}'::jsonb)
on conflict ("key") do nothing;
