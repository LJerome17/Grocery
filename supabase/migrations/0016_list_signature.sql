-- 0016 (2026-10-27): the list remembers what it was made from. Safe to run more than once; every statement stands alone.
-- Without it, removing bought items from the list ("Retirer les articles cochés") made the week page say the list was
-- out of date. list_signature = fingerprint of the generated lines when the list was made (listSignature in weekPlan.ts).
alter table week_plans add column if not exists list_signature text;

-- replace_list (0015) plus the fingerprint, in the same transaction. Runs with the caller's rights (row-level security).
create or replace function make_list(p_plan uuid, p_rows jsonb, p_signature text) returns int
language plpgsql security invoker set search_path = public as $$
declare n int;
begin
  n := replace_list(p_plan, p_rows);
  update week_plans set list_signature = p_signature where id = p_plan;
  if not found then raise exception 'plan introuvable'; end if;
  return n;
end $$;
