import { MigrationInterface, QueryRunner } from 'typeorm';

/** Courses within a department. Depends on majors and users (submitted_by). */
export class CreateSubjects1787616103000 implements MigrationInterface {
  name = 'CreateSubjects1787616103000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
create table if not exists subjects (
  id               uuid primary key default gen_random_uuid(),
  major_id         uuid not null references majors (id) on delete cascade,
  name             text not null,
  -- Short display code (initials of \`name\`, uppercased). Shown on the subject
  -- card when no cover image was uploaded. Derived by the API; admin-editable.
  acronym          text not null,
  year_level       integer not null,
  semester         integer,
  subject_url      text,
  status           text not null default 'pending'
                     check (status in ('pending','active','rejected')),
  submitted_by     uuid references users (id) on delete set null,
  rejection_reason text,
  rejected_at      timestamptz,
  reviewed_by      uuid references users (id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (major_id, name)
);

-- Foreign keys: Postgres does not index these automatically, and both are
-- ON DELETE CASCADE / SET NULL — without an index the parent delete has to
-- sequentially scan this table.
create index if not exists idx_subjects_major on subjects (major_id);
create index if not exists idx_subjects_submitted_by on subjects (submitted_by);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop table if exists subjects cascade;
    `);
  }
}
