-- recovery_protocol_cards — one row per user; the bedroom-maintenance tracker
-- ({units, dates}) as a single jsonb container. Singleton per user (PK user_id,
-- app upserts onConflict: 'user_id'). Same access model as protocol_cards:
-- own row AND paid for read/write, delete ungated by payment.
-- NOTE: RLS is also auto-enabled by the public.rls_auto_enable event trigger on
-- CREATE TABLE, but we enable it explicitly here too — the trigger is a safety
-- net, not a substitute for declaring intent. Policies must always be explicit.

create table if not exists "public"."recovery_protocol_cards" (
    "user_id"    "uuid" not null,
    "data"       "jsonb" default '{}'::"jsonb" not null,
    "updated_at" timestamp with time zone default "now"() not null
);

alter table "public"."recovery_protocol_cards" owner to "postgres";

alter table only "public"."recovery_protocol_cards"
    add constraint "recovery_protocol_cards_pkey" primary key ("user_id");

alter table only "public"."recovery_protocol_cards"
    add constraint "recovery_protocol_cards_user_id_fkey" foreign key ("user_id")
    references "auth"."users"("id") on delete cascade;

alter table "public"."recovery_protocol_cards" enable row level security;

create policy "recovery: own row, paid, select" on "public"."recovery_protocol_cards"
    for select using ((("user_id" = "auth"."uid"()) and "public"."is_paid_user"()));

create policy "recovery: own row, paid, insert" on "public"."recovery_protocol_cards"
    for insert with check ((("user_id" = "auth"."uid"()) and "public"."is_paid_user"()));

create policy "recovery: own row, paid, update" on "public"."recovery_protocol_cards"
    for update using ((("user_id" = "auth"."uid"()) and "public"."is_paid_user"()));

create policy "recovery: own row, delete" on "public"."recovery_protocol_cards"
    for delete using (("user_id" = "auth"."uid"()));

grant all on table "public"."recovery_protocol_cards" to "anon";
grant all on table "public"."recovery_protocol_cards" to "authenticated";
grant all on table "public"."recovery_protocol_cards" to "service_role";
