# Supabase migration protocol

How database schema changes are made in this project. The database structure is
managed as **Supabase CLI migrations** in `supabase/migrations/` — that directory is
the single source of truth. There is no hand-written `schema.sql`, and no one pastes
SQL into the dashboard SQL Editor by hand.

This protocol has **two roles**:

- **Migration owner** — the one person whose machine has `supabase link` set up and who
  runs `supabase db push`. Applies migrations to production and is the single point of
  control. Uses the **review checklist** below.
- **Contributors** (everyone else, including AI coding agents) — write application code
  and, when that code introduces a new table or field, write a **draft** migration for
  the owner to verify and apply. Contributors never run `db push` and never edit applied
  migrations. Follow the **contributor rules** below.

The split exists for a concrete reason. A migration is executable DDL against a live
database — a mistake can cost data. Keeping application code (which references tables)
separate from schema application (which creates them) is what prevents the failure this
project already hit once: code shipped calling a table that did not yet exist in
production, and nobody noticed until the live DB was checked directly. The checklist
below is designed to catch exactly that.

---

## The two sources of migrations

Every migration originates from one of two places, both converging on the migration
owner as the single apply point:

**Source A — a code change needs a schema change.** A contributor's application code adds
a new `sb.from('<table>')` or reads/writes a new field. That code cannot work in
production until the table/column exists. The contributor writes a **draft** migration
describing the structure their code requires; the owner verifies and applies it.

**Source B — the owner needs an infrastructure/systemic change.** Systemic columns
(`created_at`, soft-delete flags, tracing columns, etc.) that no contributor's UI code
touches. The owner writes and applies these directly — no draft step, it is the owner's
own work.

---

## Contributor rules (write a draft, never apply)

You (or your AI agent) do NOT have Supabase CLI access and MUST NOT apply migrations.
Your job is to make the owner's review fast and safe, not to produce a final migration.

### When a draft is needed

Only when your application code changes how it talks to Supabase — a new
`sb.from('<table>')`, a new column read/written, or a changed shape of an existing table.
If your change is UI/content only, or touches only a localStorage/preview path, **no
migration is needed** — say so and stop.

### What to produce

**1. A draft migration file.** Create it under `supabase/drafts/` (NOT
`supabase/migrations/`), named `DRAFT_<short_name>.sql`. Keeping drafts out of
`migrations/` means the CLI never picks them up accidentally — the owner moves the file
into `migrations/` with a real timestamp when applying.

Rules for the SQL:

- Derive the schema **strictly from the code you wrote**. Column names, types, and the
  primary/conflict key must match exactly what your code reads/writes. Do not invent
  fields the code does not use.
- Follow the project's established pattern (read the existing migrations in
  `supabase/migrations/` as the reference): a jsonb `data` column for the variable
  payload; dedicated columns ONLY for fields that are queried, indexed, or used as an
  upsert/conflict key.
- For a new table holding per-user data, include, in this order:
  - `create table if not exists` with `user_id uuid ... references auth.users(id) on
    delete cascade` (so account deletion cascades),
  - the primary key (typically `user_id` for a per-user singleton, or a composite key),
  - `alter table ... enable row level security`,
  - RLS **policies matching the project's standard model**: own row AND paid for
    select/insert/update (`user_id = auth.uid() and public.is_paid_user()`), delete gated
    by own row ONLY — NOT by paid (right to erasure must not depend on payment),
  - the Data-API grants for `anon` / `authenticated` / `service_role`, as the existing
    tables have.
- Note: production has an `rls_auto_enable` event trigger that auto-enables RLS on any
  new table in `public`. That is a safety net, not a substitute — still declare RLS and
  policies explicitly (RLS without policies locks the table to everyone, it does not open
  it).
- Use `create table if not exists`. Do **not** write `drop`, `alter ... type`, `rename`,
  or `drop column`. If you believe the change genuinely requires one of those on an
  existing table, DO NOT write it — describe what's needed in the notes and flag it
  loudly for the owner to handle manually (destructive DDL on live data needs rehearsal).

**2. A code-contract comment block** at the top of the draft SQL. List exactly:

- which method(s) in the app's data layer you added or changed (by name),
- every table the code now touches, and for each: the full list of columns the code
  reads/writes with their value shapes (e.g. `data: jsonb of {units:[...], dates:{...}}`),
- the conflict/primary key the code's upsert relies on.

This is a factual report of what your code does. It is what lets the owner verify the SQL
quickly, instead of reverse-engineering your code.

**3. A short note to the owner:** what feature this supports, any assumptions, and a loud
flag if anything touches existing data/structure or if you are unsure whether a table
already exists (you cannot see the live DB).

### What you must NOT do

- Do NOT assume a table doesn't exist and write destructive setup for it — when in doubt,
  flag it.
- Do NOT write `drop`, `alter ... type`, `rename`, or `drop column` (see the SQL rules
  above). That restriction did not move — see the standing amendment below.

### Standing amendment — the agent may apply (owner, 2026-08-16)

The owner lifted the apply ban: *"можем делать это через тебя, просто ты должен всё
проверять и не косячить перед тем как что-то делать."* Migrations, the move into
`migrations/`, and `git push` may all be done by the agent. What was traded away is the
second pair of eyes, so the verification below is not optional — it replaces the owner's
review, and skipping a step is the whole cost of the amendment.

There is **no Supabase CLI on this machine** (`which supabase` finds nothing), so
`db push` is not the route. Apply with the Management API, which works with the
`SUPABASE_ACCESS_TOKEN` already in `.env`:

```
POST https://api.supabase.com/v1/projects/<ref>/database/query   {"query": "<the file>"}
```

The `<ref>` is the subdomain of `SUPABASE_URL`. Run this checklist **before** the POST:

1. **The table really is missing.** Query the live DB (`select tablename from pg_tables
   where schemaname='public'`). Never conclude from a document.
2. **The SQL is additive and idempotent.** `create ... if not exists`, and no `drop`,
   `alter ... type`, `rename`, `truncate`, `delete`. Grep for them.
3. **The columns match the code**, name for name, plus the unique constraint any upsert's
   conflict key relies on. Read the handler, not the draft's comment block.
4. **Name the rollback out loud before applying.** For a brand-new table it is one
   `drop table` and nothing is lost, which is why no backup is needed. If a migration
   touches an existing table or its data, that is no longer true: **stop and get a real
   dump first** — and since there is no CLI, that means the owner's hands in the
   dashboard (Database -> Backups). Do not apply such a migration on your own.
5. **Verify by a different road than you applied by.** The Management API reporting
   success is not proof; re-read the table through PostgREST and check RLS, grants and
   columns against a sibling table.

---

## Migration owner checklist (verify, then apply)

Run this before every `db push`. Do NOT approve from a contributor's summary alone —
verify against the two ground truths the contributor could not see: **the live database**
and **the actual code**.

### 0. Sync
```
git checkout main && git pull      # get the draft + the code that motivates it
```

### 1. Ground truth #1 — what does the code actually touch?
```
grep -oE "sb\.from\('[a-z_]+'\)" src/app/index.html | sort -u
```
This lists every table the code references. Confirm the draft covers exactly the new
one(s) — nothing missing, nothing invented. Read the relevant data-layer method and check
the columns + shapes match the draft's code-contract comment block.

### 2. Ground truth #2 — what already exists in the live DB?
Run in the Supabase SQL Editor:
```sql
select tablename from pg_tables where schemaname = 'public';
select tablename, policyname, cmd from pg_policies where schemaname = 'public';
```
Confirm the draft's table does NOT already exist. If it does, the draft is either
redundant or should be an ALTER, not a CREATE → stop and handle manually. (This is the
step that catches "code references a table that isn't in prod", and its inverse.)

### 3. Danger scan — does the draft touch existing data?
```
grep -iE "drop |alter .* type|rename |drop column|truncate|delete from" supabase/drafts/DRAFT_*.sql
```
- **Empty** → pure additive create; safe to apply straight to prod.
- **Any hit** → NOT a routine push. This modifies existing data/structure. Rehearse on a
  local Supabase first (`supabase start`, then `supabase db reset` in Docker), verify,
  and only then apply to prod.

### 4. Pattern conformance (quick, bounded)
Confirm the draft has: `references auth.users(id) on delete cascade` for per-user data;
`enable row level security`; the four policies (select/insert/update gated by
`auth.uid() AND is_paid_user()`, delete gated by `auth.uid()` only); jsonb `data` for the
variable payload with dedicated columns only for keyed/queried fields; the Data-API
grants.

### 5. Apply
```
mv supabase/drafts/DRAFT_<name>.sql supabase/migrations/$(date +%Y%m%d%H%M%S)_<name>.sql
supabase db push        # applies only the new migration
```
Then verify in the SQL Editor: table exists (`select to_regclass('public.<name>');` is
not null), `relrowsecurity = true`, and the four policies are present.

### 6. Commit + push (owner only)
```
git add supabase/ && git commit -m "feat(db): add <name> migration" && git push
```

---

## Baseline & environment notes

- The baseline migration (`0001_baseline.sql`) was captured from production with
  `supabase db dump --linked`, then registered as applied via
  `supabase migration repair --status applied 0001`. (`supabase db pull` was unreliable
  here — under the pgdelta diff engine it reported "No schema changes found" and wrote
  nothing against the existing non-empty prod DB; `db dump` is the reliable path.)
- Migrations are **forward-only** — there are no down-migrations. A mistake is fixed by a
  new migration, not a rollback.
- `supabase link` and `supabase db push` exist **only on the migration owner's machine**.
  This is what keeps the "drafts are harmless until applied" boundary real: a draft file
  in git is just text; the only place it becomes an action against production is the
  owner's environment.
