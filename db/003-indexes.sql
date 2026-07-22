-- ============================================================================
-- ITC Sharing — 003: indexes
-- ----------------------------------------------------------------------------
-- NO TRANSACTION. Every statement uses CREATE INDEX CONCURRENTLY, which cannot
-- run inside one. Do not wrap this file in begin/commit, and run it with a
-- client that does not auto-open a transaction:
--
--   psql -X -v ON_ERROR_STOP=1 -f 003-indexes.sql
--
-- Concurrent builds do not block reads or writes, but they are slower and can
-- leave an INVALID index behind if interrupted. After running, check with:
--
--   select indexrelid::regclass from pg_index where not indisvalid;
--
-- Drop and recreate anything listed there. Idempotent — safe to re-run.
-- ============================================================================


-- ─── 1. Upload feed ──────────────────────────────────────────────────────────
-- documents.service.ts findAll() filters `status = 'active'` and always sorts
-- `uploaded_at DESC`; major_id / year_level / subject_id are optional.
--
-- The old idx_uploads_feed (status, major_id, year_level) omitted the sort
-- column entirely, so an unfiltered feed matched on `status` alone and then
-- sorted the whole result set. These three put uploaded_at last in each
-- prefix the query actually uses, letting Postgres walk the index in order
-- and stop at LIMIT.

-- Unfiltered feed, and the admin queue (status = 'pending').
create index concurrently if not exists idx_uploads_status_recent
  on uploads (status, uploaded_at desc);

-- Feed narrowed to a major, optionally a year: DocumentsView.vue.
create index concurrently if not exists idx_uploads_status_major_year_recent
  on uploads (status, major_id, year_level, uploaded_at desc);

-- Feed narrowed to a subject. Leads with subject_id so it also serves the
-- foreign key (see section 2).
create index concurrently if not exists idx_uploads_subject_recent
  on uploads (subject_id, uploaded_at desc);

-- Dashboard "my uploads" — findMine + DashboardDocuments.vue. Leads with
-- uploader_id, so it covers that foreign key too.
create index concurrently if not exists idx_uploads_uploader_recent
  on uploads (uploader_id, uploaded_at desc);


-- ─── 2. Foreign key indexes ──────────────────────────────────────────────────
-- Postgres indexes primary keys and unique columns automatically; it does NOT
-- index foreign keys. Without these, every delete or update of a parent row
-- sequentially scans the child table to enforce the constraint — and each of
-- these relationships is ON DELETE CASCADE or SET NULL, so that scan happens
-- on real user actions (deleting a major, removing an account), not just admin
-- cleanup. Cost is a few microseconds per insert.

create index concurrently if not exists idx_uploads_major
  on uploads (major_id);

create index concurrently if not exists idx_subjects_major
  on subjects (major_id);

create index concurrently if not exists idx_subjects_submitted_by
  on subjects (submitted_by);

create index concurrently if not exists idx_users_major
  on users (major_id);

create index concurrently if not exists idx_document_tags_upload
  on document_tags (upload_id);

create index concurrently if not exists idx_books_donor
  on books (donor_id);

create index concurrently if not exists idx_books_major_status
  on books (major_id, status);

create index concurrently if not exists idx_book_requests_book
  on book_requests (book_id);

create index concurrently if not exists idx_book_requests_requester
  on book_requests (requester_id);

create index concurrently if not exists idx_refresh_tokens_user
  on refresh_tokens (user_id);

-- Drives the retention job in 004.
create index concurrently if not exists idx_refresh_tokens_expires
  on refresh_tokens (expires_at);

-- Also for 004: the notification purge targets read rows past a cutoff.
-- Partial, so it stays small — unread rows are never purged and so are not
-- worth indexing here. (Per-user notification reads are already served by
-- idx_notifications_user_created from init.sql.)
create index concurrently if not exists idx_notifications_read_created
  on notifications (created_at) where is_read;


-- ─── 3. Retire the superseded indexes ────────────────────────────────────────
-- Only after their replacements above exist. Both are strict subsets of the
-- new indexes, so nothing loses coverage.
drop index concurrently if exists idx_uploads_feed;
drop index concurrently if exists idx_uploads_uploader;


-- ─── 4. Refresh planner statistics ───────────────────────────────────────────
-- New indexes are invisible to the planner's cost estimates until the tables
-- are analyzed. Cheap, and avoids a confusing "I added the index and nothing
-- got faster" window.
analyze uploads;
analyze subjects;
analyze books;
analyze book_requests;
analyze document_tags;
analyze refresh_tokens;
analyze users;
