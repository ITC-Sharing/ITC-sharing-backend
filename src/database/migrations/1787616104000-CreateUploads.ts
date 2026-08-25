import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One row per upload batch, plus the indexes the browse feed lives on.
 *
 * The feed filters on status and always sorts uploaded_at DESC with
 * major/year/subject optional, so uploaded_at goes LAST in each index prefix —
 * that lets Postgres read in order and stop at the limit instead of sorting.
 */
export class CreateUploads1787616104000 implements MigrationInterface {
  name = 'CreateUploads1787616104000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
create table if not exists uploads (
  id               uuid primary key default gen_random_uuid(),
  uploader_id      uuid references users (id) on delete set null,
  major_id         uuid not null references majors (id) on delete cascade,
  subject_id       uuid references subjects (id) on delete set null,
  title            text not null,
  description      text,
  doc_type         text not null,
  year_level       integer not null,
  academic_year    text,
  status           text not null default 'pending'
                     check (status in ('pending','active','rejected')),
  -- Who may see this upload once active. 'public' = everyone (default);
  -- 'department' = only users in the upload's major_id; 'department_year' =
  -- only users matching both major_id and year_level. Uploader + admins always
  -- see it regardless. Enforced in the feed/detail queries.
  -- Who may see this upload once active, as explicit (department, year) pairs:
  --   [{"major_id": "…", "year_level": 3}, …]
  -- Empty = visible to everyone. A viewer matches when the array contains their
  -- own department and year, so "GIC year 3 + AMS year 5" says exactly that and
  -- nothing more. Uploader + admins always see it. Enforced in the feed/detail
  -- queries. Uploads belonging to the Department of Foreign Languages always
  -- store an empty array — every student takes those courses and nobody
  -- registers into it as a department, so restricting one would only hide it.
  -- The API enforces that.
  audience         jsonb     not null default '[]'::jsonb,
  -- Optional soft expiry. Null = never expires. Once past, the upload is kept
  -- (all data intact) but hidden from everyone except its uploader and admins.
  -- Enforced in the feed/detail queries.
  expires_at       timestamptz,
  rejection_reason text,
  rejected_at      timestamptz,
  -- Who approved or rejected it (null until reviewed).
  reviewed_by      uuid references users (id) on delete set null,
  uploaded_at      timestamptz not null default now()
);

create index if not exists idx_uploads_status_recent
  on uploads (status, uploaded_at desc);
create index if not exists idx_uploads_status_major_year_recent
  on uploads (status, major_id, year_level, uploaded_at desc);
create index if not exists idx_uploads_subject_recent
  on uploads (subject_id, uploaded_at desc);
create index if not exists idx_uploads_uploader_recent
  on uploads (uploader_id, uploaded_at desc);
create index if not exists idx_uploads_major on uploads (major_id);

-- Audience containment lookups in the feed query.
create index if not exists idx_uploads_audience
  on uploads using gin (audience jsonb_path_ops);

-- Search: ILIKE '%term%' has a leading wildcard, so a B-tree cannot help and
-- every search would be a full scan. GIN trigram fixes that, over both fields.
create index if not exists idx_uploads_title_trgm
  on uploads using gin (title gin_trgm_ops);
create index if not exists idx_uploads_description_trgm
  on uploads using gin (description gin_trgm_ops);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop table if exists uploads cascade;
    `);
  }
}
