-- ============================================================================
-- ITC Sharing — 009: add uploads.expires_at (soft expiry)
-- ----------------------------------------------------------------------------
-- Run against an existing database. Idempotent — safe to re-run.
--
-- Lets an uploader set an optional expiry. Null = never expires. Once the time
-- passes, the upload and its files are kept in full (nothing deleted) but the
-- feed/detail queries hide it from everyone except its uploader and admins, so
-- the owner can still see, edit, or extend it.
--
-- init.sql declares this column inline for a fresh database; the statement below
-- brings an existing database to the same shape.
-- ============================================================================

begin;

alter table uploads
  add column if not exists expires_at timestamptz;

commit;
