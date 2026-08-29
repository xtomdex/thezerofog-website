-- First-party attribution touch log (the "own HYROS" build, CEO approved 2026-08-29).
-- One row per pageview / email-field capture on any page of the site. Identity is
-- deliberately hashed: ip_hash = sha256(TOUCH_SALT + ip), email_hash = sha256(email
-- lowercased) computed IN THE BROWSER for the pre-submit capture - the raw address of
-- someone who never pressed the button never reaches the server. Rows expire after 30
-- days via wr-retention. RLS with no policies: service key only, same as all wr_ tables.

create table if not exists public.wr_touches (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  kind text not null default 'pageview', -- pageview | email_field
  url text,
  path text,
  params jsonb,          -- utm_* / fbclid / ref, only when present
  ip_hash text,
  ua text,
  ph_distinct_id text,
  ph_session_id text,
  email_hash text
);

alter table public.wr_touches enable row level security;

create index if not exists wr_touches_ip_created_idx on public.wr_touches (ip_hash, created_at);
create index if not exists wr_touches_email_idx on public.wr_touches (email_hash);
create index if not exists wr_touches_ph_idx on public.wr_touches (ph_distinct_id);
create index if not exists wr_touches_created_idx on public.wr_touches (created_at);
