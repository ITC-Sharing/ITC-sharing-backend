-- ============================================================================
-- ITC Sharing — 014: staged_files (upload the bytes before the metadata)
-- ----------------------------------------------------------------------------
-- Run against an existing database. Idempotent — safe to re-run.
--
-- The upload form sends each file to POST /documents/staged-files as soon as
-- it's picked, so the transfer happens while the user is still filling in the
-- form instead of after they press Upload. Each row here is one object already
-- in MinIO, owned by the uploader and not yet attached to anything.
--
-- POST /documents then takes staged_file_ids, turns those rows into `documents`
-- rows and deletes them. Rows left behind (the user closed the form) are swept
-- on the owner's next staging request — see DocumentsService.purgeStaleStaged.
--
-- init.sql declares this table for a fresh database; the statements below bring
-- an existing database to the same shape.
-- ============================================================================

begin;

create table if not exists staged_files (
  id            uuid primary key default gen_random_uuid(),
  uploader_id   uuid not null references users (id) on delete cascade,
  file_url      text not null,
  -- Bucket-relative object keys, kept so the objects can be removed when a
  -- staged file is discarded or swept.
  storage_key   text not null,
  preview_url   text,
  preview_key   text,
  original_name text,
  file_size_kb  integer,
  created_at    timestamptz not null default now()
);

-- The sweep and the "my staged files" lookup both go by owner, oldest first.
create index if not exists idx_staged_files_uploader
  on staged_files (uploader_id, created_at);

commit;
