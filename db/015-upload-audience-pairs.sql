-- ============================================================================
-- ITC Sharing — 015: audience becomes (department, year) pairs
-- ----------------------------------------------------------------------------
-- Run against an existing database. Idempotent — safe to re-run.
--
-- audience_major_ids + audience_year_levels described a CROSS PRODUCT: majors
-- {GIC, AMS} with years {3, 5} meant all four combinations, so "GIC year 3 and
-- AMS year 5" could not be expressed without also opening it to GIC year 5 and
-- AMS year 3.
--
-- The new `audience` column holds the pairs themselves:
--   [{"major_id": "…", "year_level": 3}, {"major_id": "…", "year_level": 5}]
-- An empty array still means "no restriction". A viewer matches when the array
-- contains their own (major, year) — a jsonb containment test, hence the GIN
-- index. Existing rows are migrated to their cross product, which is exactly
-- what they meant before.
--
-- init.sql declares the column for a fresh database; the statements below bring
-- an existing database to the same shape.
-- ============================================================================

begin;

alter table uploads
  add column if not exists audience jsonb not null default '[]'::jsonb;

-- Expand the old two-axis form into explicit pairs.
update uploads u
   set audience = coalesce(
     (
       select jsonb_agg(jsonb_build_object('major_id', m, 'year_level', y))
         from unnest(u.audience_major_ids) m,
              unnest(u.audience_year_levels) y
     ),
     '[]'::jsonb
   )
 where jsonb_array_length(u.audience) = 0;

alter table uploads drop column if exists audience_major_ids;
alter table uploads drop column if exists audience_year_levels;

-- Containment lookups (`audience @> '[{"major_id":…,"year_level":…}]'`).
create index if not exists idx_uploads_audience
  on uploads using gin (audience jsonb_path_ops);

commit;
