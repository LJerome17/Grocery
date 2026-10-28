-- 0017 (2026-10-27): remove the accounts and households left by automated tests, and keep them out of the usage numbers.
-- Safe to run more than once; every statement stands alone. To clean up again later: select * from cleanup_tests();
--
-- Test household: not the recipe book, and either nobody is in it any more (tests leave at the end; nobody can open it),
--   or its name is one the test scripts use ("TEST …", "test-uat-…").
-- Test account: a username account "test-uat-…" (uat-e2e.mjs), or an anonymous visitor who is in no household
--   (an anonymous account with no household has nothing to come back to). Accounts with a password are never removed otherwise.

create or replace function is_test_household(h uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select h <> book_household() and exists (select 1 from households x where x.id = h and (x.name ilike 'TEST %' or x.name ilike 'test-uat-%'));
$$;

create or replace function is_test_user(u uuid) returns boolean
language sql security definer stable set search_path = public, auth as $$
  select exists (select 1 from auth.users x where x.id = u and x.email ilike 'test-uat-%@utilisateurs.momo-et-jeje.app');
$$;

-- Removes test households (with their weeks, lists, recipes and usage, by cascade), then test accounts.
-- Only from the SQL editor: nobody using the app can call it.
create or replace function cleanup_tests() returns table (households_removed int, accounts_removed int)
language plpgsql security definer set search_path = public, auth as $$
declare nh int; na int;
begin
  delete from households h
  where h.id <> book_household()
    and (is_test_household(h.id) or not exists (select 1 from household_members m where m.household_id = h.id));
  get diagnostics nh = row_count;
  delete from auth.users u
  where is_test_user(u.id)
     or (u.is_anonymous and not exists (select 1 from household_members m where m.user_id = u.id));
  get diagnostics na = row_count;
  return query select nh, na;
end $$;
revoke all on function cleanup_tests() from public, anon, authenticated;
revoke all on function is_test_user(uuid) from public, anon, authenticated;

-- Usage numbers: real people in real households only (a test running at that moment is not counted either).
create or replace function usage_summary() returns table (
  accounts bigint, active_7 bigint, active_30 bigint, visits_7 bigint, visits_30 bigint, households bigint, lists_this_week bigint, lists_next_week bigint
) language plpgsql security definer stable set search_path = public as $$
declare today date := (now() at time zone 'America/Montreal')::date;
declare monday date := today - ((extract(isodow from today))::int - 1);
begin
  if not is_member(book_household()) then raise exception 'réservé au livre de recettes'; end if;
  return query
  with m as (select x.* from household_members x where not is_test_household(x.household_id) and not is_test_user(x.user_id)),
  u as (select d.* from usage_days d where exists (select 1 from m where m.household_id = d.household_id and m.user_id = d.user_id)),
  h as (select distinct m.household_id as id from m)
  select
    (select count(distinct m.user_id) from m),
    (select count(distinct u.user_id) from u where u.day > today - 7),
    (select count(distinct u.user_id) from u where u.day > today - 30),
    (select coalesce(sum(u.opens), 0)::bigint from u where u.day > today - 7),
    (select coalesce(sum(u.opens), 0)::bigint from u where u.day > today - 30),
    (select count(*) from h),
    (select count(distinct p.household_id) from week_plans p join h on h.id = p.household_id where p.week_start = monday and exists (select 1 from shopping_items s where s.plan_id = p.id and not s.manual)),
    (select count(distinct p.household_id) from week_plans p join h on h.id = p.household_id where p.week_start = monday + 7 and exists (select 1 from shopping_items s where s.plan_id = p.id and not s.manual));
end $$;

-- Leaderboard: same rule (households with at least one real member, not named like a test).
create or replace function usage_stats() returns table (
  name text, is_book boolean, members bigint, created_at timestamptz, last_day date, days_30 bigint, opens_30 bigint, weeks bigint, lists bigint
) language plpgsql security definer stable set search_path = public as $$
declare today date := (now() at time zone 'America/Montreal')::date;
begin
  if not is_member(book_household()) then raise exception 'réservé au livre de recettes'; end if;
  return query
  select h.name, h.id = book_household(),
    (select count(*) from household_members m where m.household_id = h.id and not is_test_user(m.user_id)),
    h.created_at,
    (select max(u.day) from usage_days u where u.household_id = h.id and not is_test_user(u.user_id)),
    (select count(distinct u.day) from usage_days u where u.household_id = h.id and u.day > today - 30 and not is_test_user(u.user_id)),
    (select coalesce(sum(u.opens), 0)::bigint from usage_days u where u.household_id = h.id and u.day > today - 30 and not is_test_user(u.user_id)),
    (select count(*) from week_plans p where p.household_id = h.id and exists (select 1 from week_plan_recipes r where r.plan_id = p.id)),
    (select count(*) from week_plans p where p.household_id = h.id and exists (select 1 from shopping_items s where s.plan_id = p.id and not s.manual))
  from households h
  where not is_test_household(h.id)
    and exists (select 1 from household_members m where m.household_id = h.id and not is_test_user(m.user_id))
  order by 7 desc, 9 desc, 8 desc, h.created_at;
end $$;

-- The clean-up itself; the result shows how many households and accounts were removed.
select * from cleanup_tests();
