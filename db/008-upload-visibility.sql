-- ============================================================================
-- ITC Sharing — 008: upload audience restriction (multi-select)
-- ----------------------------------------------------------------------------
-- Run against an existing database. Idempotent — safe to re-run.
--
-- Lets an uploader restrict who can see a document once it's active, along two
-- independent multi-select axes:
--   audience_major_ids   — empty = all departments; else only those departments
--   audience_year_levels — empty = all year levels; else only those years (1..5)
-- Both empty = visible to everyone. A viewer must match every non-empty axis.
-- The uploader and admins always see their/all uploads. Enforcement lives in the
-- documents feed/detail queries, not the database.
--
-- Supersedes earlier drafts of this migration (a single-choice `visibility`
-- enum, then single-value `audience_major_id` / `audience_year_level`); the
-- drops below remove those columns if any draft ever ran. init.sql declares the
-- array columns inline for a fresh database; the statements below bring an
-- existing database to the same shape.
-- ============================================================================

begin;

-- Remove superseded columns/constraints if present.
alter table uploads drop constraint if exists uploads_visibility_check;
alter table uploads drop column if exists visibility;
alter table uploads drop column if exists audience_major_id;
alter table uploads drop column if exists audience_year_level;

alter table uploads
  add column if not exists audience_major_ids uuid[] not null default '{}';
alter table uploads
  add column if not exists audience_year_levels integer[] not null default '{}';

commit;
