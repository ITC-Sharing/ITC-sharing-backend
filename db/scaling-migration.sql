-- ============================================================================
-- ITC Sharing — scaling migration
-- ----------------------------------------------------------------------------
-- Run in the Supabase SQL editor. Safe to re-run (idempotent).
--
-- Sections:
--   1. Indexes        — speed up the hot read paths on tables that grow
--   2. Drop dead tables
--   3. timestamp -> timestamptz (fixes the timezone inconsistency)
--   4. Trigram index  — makes title search (ILIKE '%x%') usable at scale
--   5. Scheduled cleanup (pg_cron) — optional, enable when needed
-- ============================================================================


-- ─── 1. Indexes (core — the read paths that matter on growing tables) ────────
-- Postgres only auto-indexes primary keys + unique columns, NOT foreign keys
-- or filter columns. These cover the document feed, "my uploads", file joins,
-- and per-user notifications. Index maintenance on insert is microseconds —
-- negligible next to the file upload itself.

-- The /documents feed: filter by status + major + year, newest first.
create index if not exists idx_uploads_feed
  on uploads (status, major_id, year_level);

-- Dashboard "my uploads" / findMine.
create index if not exists idx_uploads_uploader
  on uploads (uploader_id);

-- Join files back to their upload (grows with every uploaded file).
create index if not exists idx_documents_upload
  on documents (upload_id);

-- Each user's notification list (filter user_id, order by created_at desc).
create index if not exists idx_notifications_user_created
  on notifications (user_id, created_at desc);

-- Secondary indexes — uncomment/add only when a query actually proves slow
-- (EXPLAIN ANALYZE shows a Seq Scan). Skipped on small / low-traffic tables.
-- create index if not exists idx_subjects_major_year on subjects (major_id, year_level);
-- create index if not exists idx_document_tags_upload on document_tags (upload_id);
-- create index if not exists idx_books_donor          on books (donor_id);
-- create index if not exists idx_books_major_status   on books (major_id, status);
-- create index if not exists idx_book_requests_book   on book_requests (book_id);
-- create index if not exists idx_book_requests_user   on book_requests (requester_id);
-- create index if not exists idx_refresh_tokens_user  on refresh_tokens (user_id);
-- create index if not exists idx_refresh_tokens_exp   on refresh_tokens (expires_at);
-- (majors is tiny — never worth indexing.)


-- ─── 2. Drop dead tables (features removed from the app) ─────────────────────
drop table if exists document_saves;       -- saved-documents feature removed
drop table if exists push_subscriptions;   -- Web Push removed (now WebSocket)


-- ─── 3. timestamp -> timestamptz ─────────────────────────────────────────────
-- These three columns were `timestamp` (no tz) while the rest are `timestamptz`
-- — that mismatch is why the frontend had to append 'Z' to dates. Only converts
-- columns still stored as `timestamp without time zone` (so re-running is safe).
-- Assumes stored values are UTC.
do $$
begin
  if (select data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'users'
          and column_name = 'created_at') = 'timestamp without time zone' then
    alter table users
      alter column created_at type timestamptz using created_at at time zone 'utc';
  end if;

  if (select data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'books'
          and column_name = 'created_at') = 'timestamp without time zone' then
    alter table books
      alter column created_at type timestamptz using created_at at time zone 'utc';
  end if;

  if (select data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'notifications'
          and column_name = 'created_at') = 'timestamp without time zone' then
    alter table notifications
      alter column created_at type timestamptz using created_at at time zone 'utc';
  end if;
end $$;


-- ─── 4. Trigram index for title search ───────────────────────────────────────
-- ILIKE '%term%' has a leading wildcard, so a normal B-tree index can't help —
-- every search is a full scan. A GIN trigram index fixes that.
create extension if not exists pg_trgm;
create index if not exists idx_uploads_title_trgm
  on uploads using gin (title gin_trgm_ops);


-- ─── 5. Scheduled cleanup (optional — enable when tables get large) ──────────
-- refresh_tokens and notifications grow forever. With pg_cron you can prune
-- them automatically. Uncomment after enabling the extension in Supabase.
--
-- create extension if not exists pg_cron;
--
-- select cron.schedule('purge-expired-refresh-tokens', '0 3 * * *', $$
--   delete from refresh_tokens where expires_at < now();
-- $$);
--
-- select cron.schedule('trim-old-notifications', '0 3 * * *', $$
--   delete from notifications where created_at < now() - interval '90 days';
-- $$);
