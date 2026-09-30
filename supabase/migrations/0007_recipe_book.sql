-- 0007 (2026-09-30): the Momo et Jéjé recipes become one shared book. Every household reads it live;
-- only the Momo et Jéjé household (invite code b5ae084f) adds, changes or removes recipes.
-- Each household keeps its own weeks and lists. Safe to run more than once; every statement stands alone.

-- The book household, fixed by id (a household cannot make itself the book by editing its own row).
do $$
declare b uuid;
begin
  select id into b from households where invite_code = 'b5ae084f';
  if b is null then raise exception 'Foyer b5ae084f introuvable'; end if;
  execute format('create or replace function book_household() returns uuid language sql immutable as $f$ select %L::uuid $f$', b);
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'households' and column_name = 'is_book') then
    execute format('alter table households add column is_book boolean generated always as (id = %L::uuid) stored', b);
  end if;
end $$;

-- Other households' copies of book recipes: their weeks now point to the book's recipe, then the copies go.
update week_plan_recipes w set recipe_id = b.id from recipes r join recipes b on b.household_id = book_household() and (b.starter_slug = r.starter_slug or b.title = r.title) where w.recipe_id = r.id and r.household_id <> book_household();
delete from recipes r where r.household_id <> book_household() and exists (select 1 from recipes b where b.household_id = book_household() and (b.starter_slug = r.starter_slug or b.title = r.title));

-- Recipes: read your own and the book's; only the book household writes.
drop policy if exists "household recipes" on recipes;
drop policy if exists "read recipes" on recipes;
drop policy if exists "book adds recipes" on recipes;
drop policy if exists "book changes recipes" on recipes;
drop policy if exists "book removes recipes" on recipes;
create policy "read recipes" on recipes for select using (is_member(household_id) or household_id = book_household());
create policy "book adds recipes" on recipes for insert with check (household_id = book_household() and is_member(household_id));
create policy "book changes recipes" on recipes for update using (household_id = book_household() and is_member(household_id)) with check (household_id = book_household() and is_member(household_id));
create policy "book removes recipes" on recipes for delete using (household_id = book_household() and is_member(household_id));

drop policy if exists "household recipe ingredients" on recipe_ingredients;
drop policy if exists "read recipe ingredients" on recipe_ingredients;
drop policy if exists "book writes recipe ingredients" on recipe_ingredients;
create policy "read recipe ingredients" on recipe_ingredients for select using (exists (select 1 from recipes r where r.id = recipe_id and (is_member(r.household_id) or r.household_id = book_household())));
create policy "book writes recipe ingredients" on recipe_ingredients for all using (exists (select 1 from recipes r where r.id = recipe_id and r.household_id = book_household() and is_member(r.household_id))) with check (exists (select 1 from recipes r where r.id = recipe_id and r.household_id = book_household() and is_member(r.household_id)));

-- Ingredients and aliases the book household created are read by everyone (grocery-list names of its recipes).
drop policy if exists "read catalogue" on ingredients;
create policy "read catalogue" on ingredients for select using (household_id is null or household_id = book_household() or is_member(household_id));
drop policy if exists "read aliases" on ingredient_aliases;
create policy "read aliases" on ingredient_aliases for select using (household_id is null or household_id = book_household() or is_member(household_id));
