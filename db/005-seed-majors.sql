-- ============================================================================
-- ITC Sharing — 005: seed majors
-- ----------------------------------------------------------------------------
-- Run against an existing database. Idempotent — safe to re-run.
--
-- Registration requires a major_id (RegisterDto) and POST /majors requires an
-- admin account, so a database with no majors cannot produce its first user.
-- Seeding one department breaks that deadlock; the rest go in through
-- POST /majors once an admin exists.
--
-- Depends on the majors_acronym_key unique constraint from 002 — the ON
-- CONFLICT clause below has nothing to match without it.
--
-- Mirrors the seed block at the end of init.sql. Keep the two in sync.
-- ============================================================================

begin;

insert into majors (name, acronym) values
  ('Department of Information and Communication Engineering', 'GIC')
on conflict (acronym) do nothing;

commit;
