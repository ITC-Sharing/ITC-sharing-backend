-- ============================================================================
-- ITC Sharing — 016: trigram index on uploads.description
-- ----------------------------------------------------------------------------
-- Run against an existing database. Idempotent — safe to re-run.
--
-- Document search matches the title OR the description (titles are short, so a
-- keyword is often only in the description). `%term%` can't use a btree index,
-- so description gets the same GIN trigram index title already has.
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction — do not wrap this
-- file in begin/commit, and run it with a client that doesn't add one.
-- ============================================================================

create extension if not exists pg_trgm;

create index concurrently if not exists idx_uploads_description_trgm
  on uploads using gin (description gin_trgm_ops);

analyze uploads;
