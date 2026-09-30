-- 0009 (2026-09-30): default variety rules are now 2 of the same dish type and 3 of the same protein per week.
-- Households still on the previous defaults (1 and 2) move to the new ones; a household that chose its own keeps it.
-- Safe to run more than once.
alter table households alter column max_same_dish_type set default 2;
alter table households alter column max_same_protein set default 3;
update households set max_same_dish_type = 2, max_same_protein = 3 where max_same_dish_type = 1 and max_same_protein = 2;
