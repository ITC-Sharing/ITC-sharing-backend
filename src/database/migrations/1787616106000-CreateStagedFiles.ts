import { MigrationInterface, QueryRunner } from 'typeorm';

/** Uploaded objects not yet attached to an upload. Depends on users. */
export class CreateStagedFiles1787616106000 implements MigrationInterface {
  name = 'CreateStagedFiles1787616106000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
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

create index if not exists idx_staged_files_uploader
  on staged_files (uploader_id, created_at);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop table if exists staged_files cascade;
    `);
  }
}
