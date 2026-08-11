-- ============================================================================
-- ITC Sharing — 010: add uploads.description
-- ----------------------------------------------------------------------------
-- Run against an existing database. Idempotent — safe to re-run.
--
-- Replaces the per-upload tags feature with a single optional free-text
-- description. The document_tags table is left in place (unused) rather than
-- dropped, so this migration is non-destructive; it can be removed separately.
--
-- init.sql declares this column inline for a fresh database.
-- ============================================================================

begin;

alter table uploads
  add column if not exists description text;

commit;
