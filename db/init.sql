-- ============================================================================
-- ITC Sharing — database schema (self-hosted Postgres)
-- ----------------------------------------------------------------------------
-- Run automatically by the postgres container on first boot (see docker-compose).
-- Idempotent where practical.
--
-- This file is the schema for a NEW database, and already includes everything
-- in 002/003/004 — a fresh volume needs only this file. Those migrations exist
-- to bring an EXISTING database to the same state; they are not run on boot.
-- Keep the two in sync: any future change belongs both here and in a migration.
-- ============================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists pg_trgm;     -- trigram index for ILIKE title search

-- ─── majors ──────────────────────────────────────────────────────────────────
create table if not exists majors (
  id        uuid primary key default gen_random_uuid(),
  name      text not null,
  acronym   text not null,
  image_url text,
  -- Department pages are resolved by lowercased acronym (the route slug), so a
  -- duplicate would make that lookup ambiguous.
  constraint majors_acronym_key unique (acronym)
);

-- ─── users ───────────────────────────────────────────────────────────────────
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  first_name    text not null,
  last_name     text not null,
  email         text not null unique,
  password_hash text not null,
  role          text not null default 'user' check (role in ('user','admin')),
  major_id      uuid references majors (id) on delete set null,
  year_level    integer,
  avatar_url    text,
  created_at    timestamptz not null default now()
);

-- ─── subjects ────────────────────────────────────────────────────────────────
create table if not exists subjects (
  id               uuid primary key default gen_random_uuid(),
  major_id         uuid not null references majors (id) on delete cascade,
  name             text not null,
  slug             text not null,
  year_level       integer not null,
  semester         integer,
  subject_url      text,
  status           text not null default 'pending'
                     check (status in ('pending','active','rejected')),
  submitted_by     uuid references users (id) on delete set null,
  rejection_reason text,
  rejected_at      timestamptz,
  created_at       timestamptz not null default now(),
  unique (major_id, name)
);

-- ─── uploads (one row per upload batch) ──────────────────────────────────────
create table if not exists uploads (
  id               uuid primary key default gen_random_uuid(),
  uploader_id      uuid references users (id) on delete set null,
  major_id         uuid not null references majors (id) on delete cascade,
  subject_id       uuid references subjects (id) on delete set null,
  title            text not null,
  doc_type         text not null,
  year_level       integer not null,
  academic_year    text,
  status           text not null default 'pending'
                     check (status in ('pending','active','rejected')),
  rejection_reason text,
  rejected_at      timestamptz,
  uploaded_at      timestamptz not null default now()
);

-- ─── documents (one row per file within an upload) ───────────────────────────
create table if not exists documents (
  id            uuid primary key default gen_random_uuid(),
  upload_id     uuid not null references uploads (id) on delete cascade,
  file_url      text not null,
  original_name text,
  file_size_kb  integer
);

-- ─── document_tags ───────────────────────────────────────────────────────────
create table if not exists document_tags (
  id        uuid primary key default gen_random_uuid(),
  upload_id uuid not null references uploads (id) on delete cascade,
  tag       text not null,
  -- Name pinned so a freshly-created database matches a migrated one exactly
  -- (002-constraints.sql adds this constraint under the same name).
  constraint document_tags_upload_tag_key unique (upload_id, tag)
);

-- ─── notifications ───────────────────────────────────────────────────────────
create table if not exists notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users (id) on delete cascade,
  type       text not null,
  message    text not null,
  is_read    boolean not null default false,
  ref_id     uuid,
  ref_type   text,
  created_at timestamptz not null default now()
);

-- ─── books ───────────────────────────────────────────────────────────────────
create table if not exists books (
  id              uuid primary key default gen_random_uuid(),
  donor_id        uuid not null references users (id) on delete cascade,
  major_id        uuid not null references majors (id) on delete cascade,
  title           text not null,
  description     text,
  contact         text,
  cover_image_url text,
  status          text not null default 'available'
                    check (status in ('available','donated')),
  created_at      timestamptz not null default now()
);

-- ─── book_requests ───────────────────────────────────────────────────────────
create table if not exists book_requests (
  id             uuid primary key default gen_random_uuid(),
  book_id        uuid not null references books (id) on delete cascade,
  requester_id   uuid not null references users (id) on delete cascade,
  message        text,
  contact        text not null,
  status         text not null default 'pending'
                   check (status in ('pending','accepted','declined')),
  requested_at   timestamptz not null default now(),
  resolved_at    timestamptz,
  decline_reason text
);

-- ─── refresh_tokens ──────────────────────────────────────────────────────────
create table if not exists refresh_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────
-- Mirrors 003-indexes.sql. Not CONCURRENTLY here: on first boot the tables are
-- empty and nothing is connected, so a plain build is instant.

-- Upload feed. The query filters on status and always sorts uploaded_at DESC,
-- with major/year/subject optional — so uploaded_at goes last in each prefix,
-- letting Postgres read in order and stop at the limit.
create index if not exists idx_uploads_status_recent
  on uploads (status, uploaded_at desc);
create index if not exists idx_uploads_status_major_year_recent
  on uploads (status, major_id, year_level, uploaded_at desc);
create index if not exists idx_uploads_subject_recent
  on uploads (subject_id, uploaded_at desc);
create index if not exists idx_uploads_uploader_recent
  on uploads (uploader_id, uploaded_at desc);

-- Foreign keys. Postgres does not index these automatically, and each one is
-- ON DELETE CASCADE / SET NULL — without an index the parent delete has to
-- sequentially scan the child table.
create index if not exists idx_uploads_major        on uploads (major_id);
create index if not exists idx_subjects_major       on subjects (major_id);
create index if not exists idx_subjects_submitted_by on subjects (submitted_by);
create index if not exists idx_users_major          on users (major_id);
create index if not exists idx_documents_upload     on documents (upload_id);
create index if not exists idx_document_tags_upload on document_tags (upload_id);
create index if not exists idx_books_donor          on books (donor_id);
create index if not exists idx_books_major_status   on books (major_id, status);
create index if not exists idx_book_requests_book   on book_requests (book_id);
create index if not exists idx_book_requests_requester on book_requests (requester_id);
create index if not exists idx_refresh_tokens_user  on refresh_tokens (user_id);

-- Per-user notification list.
create index if not exists idx_notifications_user_created
  on notifications (user_id, created_at desc);

-- Title search: ILIKE '%term%' has a leading wildcard, so a B-tree cannot help
-- and every search would be a full scan. GIN trigram fixes that.
create index if not exists idx_uploads_title_trgm
  on uploads using gin (title gin_trgm_ops);

-- Drive the retention job (see 004-retention.sql).
create index if not exists idx_refresh_tokens_expires
  on refresh_tokens (expires_at);
create index if not exists idx_notifications_read_created
  on notifications (created_at) where is_read;


-- ─── Retention ───────────────────────────────────────────────────────────────
-- refresh_tokens and notifications are append-only in the application — no code
-- path deletes from them. Defining the purge here keeps a fresh database in the
-- same state as a migrated one; see 004-retention.sql for how to schedule it.
create or replace function purge_expired_data(
  notification_retention interval default '90 days'
)
returns table (refresh_tokens_deleted bigint, notifications_deleted bigint)
language plpgsql
as $$
declare
  tokens bigint;
  notes  bigint;
begin
  delete from refresh_tokens where expires_at < now();
  get diagnostics tokens = row_count;

  -- Unread notifications are kept regardless of age — the user hasn't seen them.
  delete from notifications
   where is_read and created_at < now() - notification_retention;
  get diagnostics notes = row_count;

  return query select tokens, notes;
end $$;


-- ─── Seed: majors ────────────────────────────────────────────────────────────
-- Registration requires a major_id and POST /majors requires an admin, so a
-- database with no majors cannot produce its first user. Seeding at least one
-- breaks that deadlock. Remaining departments are added through POST /majors.
-- Mirrors 005-seed-majors.sql.
insert into majors (name, acronym) values
  ('Department of Information and Communication Engineering', 'GIC')
on conflict (acronym) do nothing;
