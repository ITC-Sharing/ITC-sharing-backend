-- ============================================================================
-- ITC Sharing — 011: drop the document_tags table
-- ----------------------------------------------------------------------------
-- Run against an existing database. Idempotent — safe to re-run.
--
-- The per-upload tags feature was replaced by uploads.description (migration
-- 010). This removes the now-unused table for good. Destructive: any remaining
-- tag rows are discarded (the feature was unused). Its unique constraint and
-- index go with the table.
--
-- Fresh databases never create the table (init.sql no longer declares it), so
-- this brings a migrated database to the same shape.
-- ============================================================================

begin;

drop table if exists document_tags;

commit;
