-- Public bucket for recipe pictures (720 px WebP). Files are stored as <household_id>/<name>.webp
-- for pictures added in the app; seeded pictures sit at the root.
-- recipes.image_url holds either a web URL or "storage:recipe-images/<path>".

insert into storage.buckets (id, name, public) values ('recipe-images', 'recipe-images', true)
on conflict (id) do nothing;

create policy "members upload recipe images" on storage.objects for insert to authenticated
  with check (bucket_id = 'recipe-images' and is_member(((storage.foldername(name))[1])::uuid));
create policy "members replace recipe images" on storage.objects for update to authenticated
  using (bucket_id = 'recipe-images' and is_member(((storage.foldername(name))[1])::uuid));
create policy "members delete recipe images" on storage.objects for delete to authenticated
  using (bucket_id = 'recipe-images' and is_member(((storage.foldername(name))[1])::uuid));
