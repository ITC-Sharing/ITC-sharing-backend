-- ============================================================================
-- ITC Sharing — 002: constraints & schema drift
-- ----------------------------------------------------------------------------
-- Run against an existing database. Idempotent — safe to re-run.
-- Runs inside a single transaction. Index work lives in 003 (it cannot share
-- a transaction with CREATE INDEX CONCURRENTLY).
--
-- PRE-FLIGHT — run these three queries first and fix anything they return.
-- Every statement below will otherwise fail loudly rather than corrupt data.
--
--   select acronym, count(*) from majors group by acronym having count(*) > 1;
--
--   select distinct semester from subjects
--     where semester is not null and semester !~ '^\d+$';
--
--   select 'uploads' t, status v from uploads
--     where status not in ('pending','active','rejected')
--   union all select 'subjects', status from subjects
--     where status not in ('pending','active','rejected')
--   union all select 'books', status from books
--     where status not in ('available','donated')
--   union all select 'book_requests', status from book_requests
--     where status not in ('pending','accepted','declined')
--   union all select 'users', role from users
--     where role not in ('user','admin');
-- ============================================================================

begin;


-- ─── 1. subjects.semester: varchar -> integer ────────────────────────────────
-- The live database drifted to varchar while subject.entity.ts declares
-- `semester: number | null`. Converts only if still a string type, so re-runs
-- are no-ops. Blank strings become null rather than erroring.
do $$
begin
  if (select data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'subjects'
          and column_name = 'semester') in
     ('character varying', 'text', 'character') then
    alter table subjects
      alter column semester type integer
      using nullif(btrim(semester), '')::integer;
  end if;
end $$;


-- ─── 2. refresh_tokens.created_at ────────────────────────────────────────────
-- Present in the live database but absent from init.sql and the entity.
-- Adopting it (rather than dropping) — it is useful for auditing token issuance
-- and costs nothing. refresh-token.entity.ts is updated to match.
alter table refresh_tokens
  add column if not exists created_at timestamptz not null default now();


-- ─── 3. document_tags: forbid duplicate tags per upload ──────────────────────
-- Nothing stopped the same tag being attached to an upload twice. Collapse any
-- existing duplicates (keeping the lowest id), then add the constraint.
delete from document_tags a
  using document_tags b
 where a.upload_id = b.upload_id
   and a.tag       = b.tag
   and a.id        > b.id;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'document_tags_upload_tag_key') then
    alter table document_tags
      add constraint document_tags_upload_tag_key unique (upload_id, tag);
  end if;
end $$;


-- ─── 4. CHECK constraints on status / role ───────────────────────────────────
-- These columns are free text. A typo ('Active' vs 'active') writes cleanly and
-- the row then silently disappears from every query that filters on it — no
-- error, nothing in the logs. Values below are exactly those the code emits.
--
-- Added NOT VALID so the ACCESS EXCLUSIVE lock is brief: existing rows are not
-- scanned here. Section 5 validates them afterwards under a weaker lock.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'uploads_status_check') then
    alter table uploads add constraint uploads_status_check
      check (status in ('pending','active','rejected')) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'subjects_status_check') then
    alter table subjects add constraint subjects_status_check
      check (status in ('pending','active','rejected')) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'books_status_check') then
    alter table books add constraint books_status_check
      check (status in ('available','donated')) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'book_requests_status_check') then
    alter table book_requests add constraint book_requests_status_check
      check (status in ('pending','accepted','declined')) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'users_role_check') then
    alter table users add constraint users_role_check
      check (role in ('user','admin')) not valid;
  end if;
end $$;


-- ─── 5. Validate the constraints against existing rows ───────────────────────
-- Takes only a SHARE UPDATE EXCLUSIVE lock — reads and writes continue. If the
-- pre-flight query was skipped and a bad row exists, this is where it fails,
-- and the whole transaction rolls back harmlessly.
alter table uploads       validate constraint uploads_status_check;
alter table subjects      validate constraint subjects_status_check;
alter table books         validate constraint books_status_check;
alter table book_requests validate constraint book_requests_status_check;
alter table users         validate constraint users_role_check;


-- ─── 6. majors.acronym: unique ───────────────────────────────────────────────
-- Department pages resolve by lowercased acronym, so duplicates make that
-- lookup ambiguous. Required before POST /majors can be trusted.
--
-- Unlike section 3, duplicates are NOT collapsed automatically: subjects and
-- uploads reference majors with ON DELETE CASCADE, so dropping the losing row
-- would take its subjects and documents with it. Merge by hand instead —
-- repoint the children, then delete the empty major:
--
--   update subjects set major_id = :keep where major_id = :drop;
--   update uploads  set major_id = :keep where major_id = :drop;
--   update users    set major_id = :keep where major_id = :drop;
--   delete from majors where id = :drop;
do $$
declare
  dupes text;
begin
  select string_agg(acronym, ', ') into dupes
    from (select acronym from majors group by acronym having count(*) > 1) d;

  if dupes is not null then
    raise exception
      'Duplicate major acronyms: %. Merge them by hand before adding the unique constraint (see comment above).', dupes;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'majors_acronym_key') then
    alter table majors add constraint majors_acronym_key unique (acronym);
  end if;
end $$;


commit;
