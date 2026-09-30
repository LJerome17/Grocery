// Generate supabase/migrations/0005_validation_fixes.sql (2026-09-30): postal code, starter recipe ids,
// catalogue equivalences, storage limits, member join date, then the up-to-date catalogue seed.
// Usage: npx tsx scripts/build-starter.ts && npx tsx scripts/build-seed.ts && npx tsx scripts/gen-0005.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const starter = JSON.parse(readFileSync(join(ROOT, "public", "starter", "recipes.json"), "utf8")) as { slug: string; title: string }[];
const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

const sql = [
  "-- 0005: fixes from the validation review (2026-09-30). Safe to run more than once.",
  "",
  "-- Regional Maxi flyer.",
  "alter table households add column if not exists postal_code text default 'H4C 0B8';",
  "update households set postal_code = 'H4C 0B8' where postal_code is null;",
  "",
  "-- Starter recipes are tracked by a stable id, never by title; a deleted one is never added back.",
  "alter table recipes add column if not exists starter_slug text;",
  "create unique index if not exists recipes_starter_slug_uq on recipes (household_id, starter_slug) where starter_slug is not null;",
  "alter table households add column if not exists starter_seen text[] not null default '{}';",
  ...starter.map((r) => `update recipes set starter_slug = ${q(r.slug)} where starter_slug is null and title = ${q(r.title)};`),
  `update households set starter_seen = array[${starter.map((r) => q(r.slug)).join(", ")}]::text[] where starter_seen = '{}' and id in (select household_id from recipes where starter_slug is not null);`,
  "",
  "-- Stable choice of household for people in several; buying-unit equivalences of the catalogue.",
  "alter table household_members add column if not exists joined_at timestamptz not null default now();",
  "alter table ingredients add column if not exists equiv jsonb;",
  "",
  "-- Recipe pictures: images only, 1 MB max.",
  "update storage.buckets set file_size_limit = 1048576, allowed_mime_types = array['image/webp','image/jpeg','image/png'] where id = 'recipe-images';",
  "",
  readFileSync(join(ROOT, "data", "protein-updates.sql"), "utf8"),
  readFileSync(join(ROOT, "supabase", "seed", "01_catalog.sql"), "utf8"),
];
writeFileSync(join(ROOT, "supabase", "migrations", "0005_validation_fixes.sql"), sql.join("\n") + "\n");
console.log(`${starter.length} recettes de départ -> supabase/migrations/0005_validation_fixes.sql`);
