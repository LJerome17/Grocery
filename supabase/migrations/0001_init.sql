-- Épicerie: initial schema.
-- Every household (foyer) sees only its own data, enforced by row-level security.
-- Run in the Supabase SQL editor, or with `supabase db push`.

create extension if not exists pgcrypto;

-- ---------- Households ----------

create table households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text not null unique default substr(encode(gen_random_bytes(6), 'hex'), 1, 8),
  -- Variety rules used by the planner (phase 2).
  max_same_dish_type int not null default 1,
  max_same_protein int not null default 2,
  repeat_cooldown_weeks int not null default 3,
  created_at timestamptz not null default now()
);

create table household_members (
  household_id uuid not null references households on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  display_name text,
  primary key (household_id, user_id)
);

create or replace function is_member(h uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from household_members where household_id = h and user_id = auth.uid());
$$;

create or replace function create_household(p_name text, p_display_name text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare h uuid;
begin
  insert into households (name) values (p_name) returning id into h;
  insert into household_members (household_id, user_id, display_name) values (h, auth.uid(), p_display_name);
  return h;
end $$;

create or replace function join_household(p_code text, p_display_name text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare h uuid;
begin
  select id into h from households where invite_code = lower(trim(p_code));
  if h is null then raise exception 'Code d''invitation invalide'; end if;
  insert into household_members (household_id, user_id, display_name)
  values (h, auth.uid(), p_display_name) on conflict do nothing;
  return h;
end $$;

-- ---------- Ingredient catalogue ----------
-- household_id null = global catalogue shared by everyone (seeded); otherwise a household's own addition.

create table ingredients (
  id uuid primary key default gen_random_uuid(),
  household_id uuid references households on delete cascade,
  name text not null,                 -- canonical French name shown on the list
  aisle text not null default 'autre',
  pantry boolean not null default false,  -- salt, spices, oil: shown apart, not bought weekly
  grams_per_unit numeric,             -- 1 onion ~ 150 g (for unit conversions, phase 4)
  ml_per_can numeric,                 -- Canadian can size, e.g. 796 for tomatoes
  created_at timestamptz not null default now()
);
create unique index ingredients_name_uq on ingredients (coalesce(household_id, '00000000-0000-0000-0000-000000000000'), lower(name));

create table ingredient_aliases (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references ingredients on delete cascade,
  household_id uuid references households on delete cascade,
  alias text not null                 -- nameKey(): lowercase, no accents, no punctuation
);
create unique index ingredient_aliases_uq on ingredient_aliases (coalesce(household_id, '00000000-0000-0000-0000-000000000000'), alias);

-- Package sizes sold in stores (phase 4, anti-waste).
create table ingredient_formats (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references ingredients on delete cascade,
  household_id uuid references households on delete cascade,
  store text,                         -- null = any store; 'costco' for bulk sizes
  amount numeric not null,
  unit text not null,                 -- 'g', 'ml' or a count unit key
  label text                          -- "473 ml", "sac de 2 lb"
);

-- ---------- Recipes ----------

create table recipes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  title text not null,
  source_type text not null default 'manual' check (source_type in ('url', 'photo', 'pdf', 'manual')),
  source_url text,
  file_path text,                     -- photo/PDF in storage
  image_url text,
  servings numeric,
  total_minutes int,
  instructions jsonb not null default '[]',
  notes text,
  dish_type text,                     -- pâtes, riz, soupe, ramen, mijoté, salade, four, sandwich...
  protein text,                       -- poulet, bœuf, porc, poisson, végé, tofu...
  seasons text[] not null default '{printemps,ete,automne,hiver}',
  rating smallint check (rating between 1 and 5),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index recipes_household_idx on recipes (household_id);

create table recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references recipes on delete cascade,
  position int not null default 0,
  section text,
  raw text not null,
  quantity numeric,
  quantity_max numeric,
  unit text,
  name text not null,
  note text,
  optional boolean not null default false,
  ingredient_id uuid references ingredients on delete set null
);
create index recipe_ingredients_recipe_idx on recipe_ingredients (recipe_id);

-- ---------- Weekly plan and shopping list ----------

create table week_plans (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  week_start date not null,
  suppers int not null default 5,
  people int not null default 2,      -- people at supper
  lunches int not null default 2,     -- lunch portions from leftovers
  store text not null default 'maxi',
  created_at timestamptz not null default now(),
  unique (household_id, week_start)
);

create table week_plan_recipes (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references week_plans on delete cascade,
  recipe_id uuid not null references recipes on delete cascade,
  portions numeric not null,
  position int not null default 0,
  cooked boolean not null default false
);

create table shopping_items (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references week_plans on delete cascade,
  ingredient_id uuid references ingredients on delete set null,
  label text not null,
  quantity_text text,
  aisle text not null default 'autre',
  pantry boolean not null default false,
  manual boolean not null default false,
  checked boolean not null default false,
  position int not null default 0
);
create index shopping_items_plan_idx on shopping_items (plan_id);

-- ---------- Flyer deals (phase 3) ----------

create table flyer_deals (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  ingredient_id uuid not null references ingredients on delete cascade,
  store text not null,
  week_start date not null,
  price_text text,
  unique (household_id, ingredient_id, store, week_start)
);

-- ---------- Row-level security ----------

alter table households enable row level security;
alter table household_members enable row level security;
alter table ingredients enable row level security;
alter table ingredient_aliases enable row level security;
alter table ingredient_formats enable row level security;
alter table recipes enable row level security;
alter table recipe_ingredients enable row level security;
alter table week_plans enable row level security;
alter table week_plan_recipes enable row level security;
alter table shopping_items enable row level security;
alter table flyer_deals enable row level security;

create policy "members read household" on households for select using (is_member(id));
create policy "members update household" on households for update using (is_member(id));
create policy "members read members" on household_members for select using (is_member(household_id));
create policy "leave household" on household_members for delete using (user_id = auth.uid());

-- Catalogue tables: global rows readable by all signed-in users, household rows by members.
create policy "read catalogue" on ingredients for select using (household_id is null or is_member(household_id));
create policy "write own catalogue" on ingredients for all using (is_member(household_id)) with check (is_member(household_id));
create policy "read aliases" on ingredient_aliases for select using (household_id is null or is_member(household_id));
create policy "write own aliases" on ingredient_aliases for all using (is_member(household_id)) with check (is_member(household_id));
create policy "read formats" on ingredient_formats for select using (household_id is null or is_member(household_id));
create policy "write own formats" on ingredient_formats for all using (is_member(household_id)) with check (is_member(household_id));

create policy "household recipes" on recipes for all using (is_member(household_id)) with check (is_member(household_id));
create policy "household recipe ingredients" on recipe_ingredients for all
  using (exists (select 1 from recipes r where r.id = recipe_id and is_member(r.household_id)))
  with check (exists (select 1 from recipes r where r.id = recipe_id and is_member(r.household_id)));
create policy "household plans" on week_plans for all using (is_member(household_id)) with check (is_member(household_id));
create policy "household plan recipes" on week_plan_recipes for all
  using (exists (select 1 from week_plans p where p.id = plan_id and is_member(p.household_id)))
  with check (exists (select 1 from week_plans p where p.id = plan_id and is_member(p.household_id)));
create policy "household shopping" on shopping_items for all
  using (exists (select 1 from week_plans p where p.id = plan_id and is_member(p.household_id)))
  with check (exists (select 1 from week_plans p where p.id = plan_id and is_member(p.household_id)));
create policy "household deals" on flyer_deals for all using (is_member(household_id)) with check (is_member(household_id));

-- Live sync of the shopping list between phones.
alter publication supabase_realtime add table shopping_items;
