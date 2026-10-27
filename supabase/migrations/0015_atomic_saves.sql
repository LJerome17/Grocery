-- 0015 (2026-10-27): saves that succeed or fail as a whole (audit: a dropped connection could leave a week or a list
-- empty, or a postponed recipe in both weeks). Safe to run more than once; every statement stands alone.
-- Both functions run with the caller's rights: the usual row-level security applies.

-- One or more weeks of a household: settings, recipes in order, postponed / already-bought marks.
-- p_weeks: [{week_start, suppers, portions, seasons[], exclude_dish_types[], recipes: [{recipe_id, position, multiplier, portions, postponed, already_bought}]}]
-- Returns [{plan, items}] in the same order.
create or replace function save_weeks(p_household uuid, p_weeks jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare w jsonb; pid uuid; result jsonb := '[]'::jsonb;
begin
  for w in select value from jsonb_array_elements(p_weeks) loop
    insert into week_plans (household_id, week_start, suppers, portions, seasons, exclude_dish_types)
    values (p_household, (w->>'week_start')::date, (w->>'suppers')::int, (w->>'portions')::int,
      array(select jsonb_array_elements_text(coalesce(w->'seasons', '[]'::jsonb))),
      array(select jsonb_array_elements_text(coalesce(w->'exclude_dish_types', '[]'::jsonb))))
    on conflict (household_id, week_start) do update set suppers = excluded.suppers, portions = excluded.portions,
      seasons = excluded.seasons, exclude_dish_types = excluded.exclude_dish_types
    returning id into pid;
    delete from week_plan_recipes where plan_id = pid;
    insert into week_plan_recipes (plan_id, recipe_id, position, multiplier, portions, postponed, already_bought)
    select pid, (r->>'recipe_id')::uuid, (r->>'position')::int, (r->>'multiplier')::int, (r->>'portions')::numeric,
      coalesce((r->>'postponed')::boolean, false), coalesce((r->>'already_bought')::boolean, false)
    from jsonb_array_elements(coalesce(w->'recipes', '[]'::jsonb)) r;
    result := result || jsonb_build_array(jsonb_build_object(
      'plan', (select to_jsonb(p) from week_plans p where p.id = pid),
      'items', coalesce((select jsonb_agg(to_jsonb(x) order by x.position) from week_plan_recipes x where x.plan_id = pid), '[]'::jsonb)));
  end loop;
  return result;
end $$;

-- The generated lines of a plan's list (manual items kept). What was ticked stays ticked (generated lines only:
-- a ticked manual item never ticks a generated line), keyed by catalogue item, else by label.
-- p_rows: [{ingredient_id, label, quantity_text, aisle, pantry, position}]
create or replace function replace_list(p_plan uuid, p_rows jsonb) returns int
language plpgsql security invoker set search_path = public as $$
declare ticked text[]; n int;
begin
  select coalesce(array_agg(coalesce(ingredient_id::text, 'label:' || label)), '{}') into ticked
  from shopping_items where plan_id = p_plan and checked and not manual;
  delete from shopping_items where plan_id = p_plan and not manual;
  insert into shopping_items (plan_id, ingredient_id, label, quantity_text, aisle, pantry, manual, checked, position)
  select p_plan, nullif(r->>'ingredient_id', '')::uuid, r->>'label', r->>'quantity_text', r->>'aisle',
    coalesce((r->>'pantry')::boolean, false), false,
    coalesce(nullif(r->>'ingredient_id', ''), 'label:' || (r->>'label')) = any(ticked), (r->>'position')::int
  from jsonb_array_elements(p_rows) r;
  get diagnostics n = row_count;
  return n;
end $$;

-- Usage: only people still in a household count (test runs leave anonymous visitors who left their household).
create or replace function usage_summary() returns table (
  accounts bigint, active_7 bigint, active_30 bigint, visits_7 bigint, visits_30 bigint, households bigint, lists_this_week bigint, lists_next_week bigint
) language plpgsql security definer stable set search_path = public as $$
declare today date := (now() at time zone 'America/Montreal')::date;
declare monday date := today - ((extract(isodow from today))::int - 1);
begin
  if not is_member(book_household()) then raise exception 'réservé au livre de recettes'; end if;
  return query
  with u as (select d.* from usage_days d where exists (select 1 from household_members m where m.household_id = d.household_id and m.user_id = d.user_id))
  select
    (select count(distinct m.user_id) from household_members m),
    (select count(distinct u.user_id) from u where u.day > today - 7),
    (select count(distinct u.user_id) from u where u.day > today - 30),
    (select coalesce(sum(u.opens), 0)::bigint from u where u.day > today - 7),
    (select coalesce(sum(u.opens), 0)::bigint from u where u.day > today - 30),
    (select count(*) from households h where exists (select 1 from household_members m where m.household_id = h.id)),
    (select count(distinct p.household_id) from week_plans p where p.week_start = monday and exists (select 1 from shopping_items s where s.plan_id = p.id and not s.manual)),
    (select count(distinct p.household_id) from week_plans p where p.week_start = monday + 7 and exists (select 1 from shopping_items s where s.plan_id = p.id and not s.manual));
end $$;
