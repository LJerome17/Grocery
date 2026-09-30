-- 0008 (2026-09-30): the recipe book moves to the new Momo et Jéjé household (invite code 5e35aedc).
-- Its recipes, household ingredients and aliases move with it (same ids, so every household's weeks still work);
-- the previous book household is deleted if nobody is left in it. Safe to run more than once.
do $$
declare
  b uuid;
  old uuid := book_household();
begin
  select id into b from households where invite_code = '5e35aedc';
  if b is null then raise exception 'Foyer 5e35aedc introuvable'; end if;
  if old is not distinct from b then return; end if;
  update recipes set household_id = b where household_id = old;
  update ingredients set household_id = b where household_id = old;
  update ingredient_aliases set household_id = b where household_id = old;
  update households set starter_seen = (select starter_seen from households where id = old) where id = b;
  execute format('create or replace function book_household() returns uuid language sql immutable as $f$ select %L::uuid $f$', b);
  alter table households drop column if exists is_book;
  execute format('alter table households add column is_book boolean generated always as (id = %L::uuid) stored', b);
  delete from households h where h.id = old and not exists (select 1 from household_members m where m.household_id = old);
end $$;
