-- 0014 (2026-10-27): a recipe can be postponed to the next week. Safe to run more than once; every statement stands alone.
-- postponed: moved from the previous week (kept when the week is suggested again).
-- already_bought: its ingredients were bought with the previous week's list, so they stay off this week's list.
alter table week_plan_recipes add column if not exists postponed boolean not null default false;
alter table week_plan_recipes add column if not exists already_bought boolean not null default false;
-- The recipe book household gets a name people recognise when they sign in again.
update households set name = 'Momo et Jéjé' where id = book_household();

-- Lemon and lime juice: a recipe that only wants the juice buys the juice (rule in src/lib/shopping.ts).
with c(name, aisle, name_en) as (values
('Jus de citron', 'fruits-legumes', 'Lemon juice'),
('Jus de lime', 'fruits-legumes', 'Lime juice')
)
insert into ingredients (household_id, name, aisle, pantry, name_en) select null, c.name, c.aisle, false, c.name_en from c where not exists (select 1 from ingredients i where i.household_id is null and i.name = c.name);
with c(name, alias) as (values
('Jus de citron', 'jus de citron en bouteille'),
('Jus de citron', 'bottled lemon juice'),
('Jus de lime', 'jus de lime en bouteille'),
('Jus de lime', 'bottled lime juice')
)
insert into ingredient_aliases (ingredient_id, household_id, alias) select i.id, null, c.alias from c join ingredients i on i.household_id is null and i.name = c.name on conflict do nothing;

-- Usage: one row per person, household and day the app is opened (Montréal time). Only read through usage_stats().
create table if not exists usage_days (
  household_id uuid not null references households on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  day date not null,
  opens int not null default 1,
  primary key (household_id, user_id, day)
);
alter table usage_days enable row level security;
create or replace function log_usage() returns void language sql security definer set search_path = public as $$
  insert into usage_days (household_id, user_id, day)
  select m.household_id, m.user_id, (now() at time zone 'America/Montreal')::date from household_members m where m.user_id = auth.uid()
  on conflict (household_id, user_id, day) do update set opens = usage_days.opens + 1;
$$;
-- Totals, for the recipe book's members only (Réglages → Utilisation). "Active" = opened the app in the period.
create or replace function usage_summary() returns table (
  accounts bigint, active_7 bigint, active_30 bigint, visits_7 bigint, visits_30 bigint, households bigint, lists_this_week bigint, lists_next_week bigint
) language plpgsql security definer stable set search_path = public as $$
declare today date := (now() at time zone 'America/Montreal')::date;
declare monday date := today - ((extract(isodow from today))::int - 1);
begin
  if not is_member(book_household()) then raise exception 'réservé au livre de recettes'; end if;
  return query select
    (select count(distinct m.user_id) from household_members m),
    (select count(distinct u.user_id) from usage_days u where u.day > today - 7),
    (select count(distinct u.user_id) from usage_days u where u.day > today - 30),
    (select coalesce(sum(u.opens), 0)::bigint from usage_days u where u.day > today - 7),
    (select coalesce(sum(u.opens), 0)::bigint from usage_days u where u.day > today - 30),
    (select count(*) from households h where exists (select 1 from household_members m where m.household_id = h.id)),
    (select count(distinct p.household_id) from week_plans p where p.week_start = monday and exists (select 1 from shopping_items s where s.plan_id = p.id and not s.manual)),
    (select count(distinct p.household_id) from week_plans p where p.week_start = monday + 7 and exists (select 1 from shopping_items s where s.plan_id = p.id and not s.manual));
end $$;
-- Leaderboard per household (most visits in the last 30 days first), for the recipe book's members only.
create or replace function usage_stats() returns table (
  name text, is_book boolean, members bigint, created_at timestamptz, last_day date, days_30 bigint, opens_30 bigint, weeks bigint, lists bigint
) language plpgsql security definer stable set search_path = public as $$
declare today date := (now() at time zone 'America/Montreal')::date;
begin
  if not is_member(book_household()) then raise exception 'réservé au livre de recettes'; end if;
  return query
  select h.name, h.id = book_household(),
    (select count(*) from household_members m where m.household_id = h.id),
    h.created_at,
    (select max(u.day) from usage_days u where u.household_id = h.id),
    (select count(distinct u.day) from usage_days u where u.household_id = h.id and u.day > today - 30),
    (select coalesce(sum(u.opens), 0)::bigint from usage_days u where u.household_id = h.id and u.day > today - 30),
    (select count(*) from week_plans p where p.household_id = h.id and exists (select 1 from week_plan_recipes r where r.plan_id = p.id)),
    (select count(*) from week_plans p where p.household_id = h.id and exists (select 1 from shopping_items s where s.plan_id = p.id and not s.manual))
  from households h
  where exists (select 1 from household_members m where m.household_id = h.id)
  order by 7 desc, 9 desc, 8 desc, h.created_at;
end $$;
