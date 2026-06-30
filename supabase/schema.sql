-- The Zero Fog — Supabase schema, helper function, and RLS policies
--
-- Run this top-to-bottom in the Supabase SQL editor (Database → SQL Editor).
-- Order: extensions → tables → helper function → enable RLS → policies.
--
-- Security model: the browser uses the PUBLIC anon key, so Row Level Security
-- is the core protection. Two separate concepts:
--   * Authentication = user proved ownership of an email via OTP (auth.uid()).
--   * Authorization  = profiles.is_paid = true (gated in RLS, not just the UI).
-- Diary/assessment reads & writes require BOTH own-row AND paid. Deletion is
-- ungated by payment (right to erasure must not depend on payment status).

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

-- gen_random_uuid() lives in pgcrypto. Usually already present on Supabase,
-- but create it defensively so the script is self-contained.
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- profiles — one row per user; the access-gating record.
-- Rows are created server-side (service_role) at purchase, never by the client.
create table if not exists public.profiles (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  email              text        not null,
  is_paid            boolean     not null default false,
  paid_at            timestamptz,
  payment_session_id text,
  consent_at         timestamptz,            -- when health-data consent was given
  consent_version    text,                   -- which consent copy version was agreed to
  created_at         timestamptz not null default now()
);

-- diary_entries — nightly log.
-- Design rule: jsonb for the variable input payload; dedicated columns only for
-- fields that are queried, indexed, or used by the app's upsert key.
create table if not exists public.diary_entries (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  entry_date date        not null,
  sleep_eff  smallint,                              -- derived sleep-efficiency %, null when inputs incomplete
  data       jsonb       not null default '{}'::jsonb, -- all diary input fields (see below)
  updated_at timestamptz not null default now(),
  -- Composite PK powers the app's upsert (onConflict: 'user_id,entry_date').
  primary key (user_id, entry_date)
);
-- `data` jsonb holds: intoBed, tried, finalWake, outBed (time strings),
-- sol, waso (bucket indices), wakings (int), caffeine (time string or 'none'),
-- alcohol, nap, exercise, aid (chip indices), quality (1-5), notes (string).

-- assessments — questionnaire results (insert-only records).
create table if not exists public.assessments (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references auth.users(id) on delete cascade,
  taken_on        date        not null,
  score_total     smallint    not null,   -- 0-48
  score_clock     smallint    not null,   -- section A
  score_battery   smallint    not null,   -- section B
  score_offswitch smallint    not null,   -- section C
  answers         jsonb       not null,   -- raw {aq0: idx, ...}; source of truth, scores derived from these
  created_at      timestamptz not null default now()
);

create index if not exists assessments_user_taken_idx
  on public.assessments (user_id, taken_on);

-- ---------------------------------------------------------------------------
-- Helper function — paid check
-- ---------------------------------------------------------------------------

-- security definer so the function can read profiles regardless of the caller's
-- RLS; stable since it does not modify data and is consistent within a statement.
create or replace function public.is_paid_user() returns boolean
language sql security definer stable as $$
  select coalesce((select is_paid from public.profiles where user_id = auth.uid()), false);
$$;

-- ---------------------------------------------------------------------------
-- Enable Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles      enable row level security;
alter table public.diary_entries enable row level security;
alter table public.assessments   enable row level security;

-- ---------------------------------------------------------------------------
-- Policies — profiles (own row only; no client INSERT)
-- ---------------------------------------------------------------------------

create policy "profiles: own row, select"
  on public.profiles for select
  using (user_id = auth.uid());

create policy "profiles: own row, update"
  on public.profiles for update
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Policies — diary_entries (own rows AND paid; delete ungated by payment)
-- ---------------------------------------------------------------------------

create policy "diary: own rows, paid, select"
  on public.diary_entries for select
  using (user_id = auth.uid() and public.is_paid_user());

create policy "diary: own rows, paid, insert"
  on public.diary_entries for insert
  with check (user_id = auth.uid() and public.is_paid_user());

create policy "diary: own rows, paid, update"
  on public.diary_entries for update
  using (user_id = auth.uid() and public.is_paid_user());

create policy "diary: own rows, delete"
  on public.diary_entries for delete
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Policies — assessments (own rows AND paid; delete ungated; no update)
-- ---------------------------------------------------------------------------

create policy "assessments: own rows, paid, select"
  on public.assessments for select
  using (user_id = auth.uid() and public.is_paid_user());

create policy "assessments: own rows, paid, insert"
  on public.assessments for insert
  with check (user_id = auth.uid() and public.is_paid_user());

create policy "assessments: own rows, delete"
  on public.assessments for delete
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- protocol_cards — one row per user; their one-page Protocol Card (14 settings).
-- Singleton per user: PK is user_id, the app upserts onConflict: 'user_id'.
-- Same access model as diary/assessment: own row AND paid for read/write,
-- delete ungated by payment (right to erasure).
-- ---------------------------------------------------------------------------
create table if not exists public.protocol_cards (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,  -- the 14 protocol fields (wake, sleep, caffeine, ...)
  updated_at timestamptz not null default now()
);

alter table public.protocol_cards enable row level security;

create policy "protocol: own row, paid, select"
  on public.protocol_cards for select
  using (user_id = auth.uid() and public.is_paid_user());

create policy "protocol: own row, paid, insert"
  on public.protocol_cards for insert
  with check (user_id = auth.uid() and public.is_paid_user());

create policy "protocol: own row, paid, update"
  on public.protocol_cards for update
  using (user_id = auth.uid() and public.is_paid_user());

create policy "protocol: own row, delete"
  on public.protocol_cards for delete
  using (user_id = auth.uid());
