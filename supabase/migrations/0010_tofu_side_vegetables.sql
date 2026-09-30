-- 0010 (2026-09-30): recipes with tofu alone get the open side-vegetables line (user rule), in the recipe book.
-- Safe to run more than once: a recipe that already has the line is left alone.
insert into recipe_ingredients (recipe_id, position, section, raw, quantity, quantity_max, unit, name, note, optional, ingredient_id)
select r.id, coalesce((select max(position) + 1 from recipe_ingredients x where x.recipe_id = r.id), 0), null, 'Légumes pour accompagner le tofu (au choix)', null, null, null, 'Légumes pour accompagner le tofu', 'au choix', false, c.id
from recipes r
join ingredients c on c.household_id is null and c.name = 'Légumes d''accompagnement (au choix)'
where r.household_id = book_household()
  and (r.starter_slug in ('tofu-magique-general-tao-sur-le-bbq', 'tofu-grille-aux-olives-et-a-l-aneth') or r.title = 'Tofu sucré-salé')
  and not exists (select 1 from recipe_ingredients x where x.recipe_id = r.id and x.ingredient_id = c.id);
