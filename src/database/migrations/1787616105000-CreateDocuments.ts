import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One row per file within an upload. Depends on uploads and users.
 *
 * On `status`: review used to be whole-upload only, via `uploads.status`. That
 * works for a new submission, where every file arrives at once, but not for a
 * file added to an upload that is already approved and in the feed — re-pending
 * the whole upload would pull an approved document, and its already-reviewed
 * files, out of the feed over one new attachment.
 *
 * So a file carries its own status. Only the new file is hidden; the upload and
 * its approved files stay where they were, and the file appears once a
 * moderator clears it. Files arriving with a NEW upload are 'active' — the
 * upload's own group review covers them.
 */
export class CreateDocuments1787616105000 implements MigrationInterface {
  name = 'CreateDocuments1787616105000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
create table if not exists documents (
  id            uuid primary key default gen_random_uuid(),
  upload_id     uuid not null references uploads (id) on delete cascade,
  file_url      text not null,
  -- PDF rendition for in-browser preview of office files; null otherwise.
  preview_url   text,
  original_name text,
  file_size_kb  integer,
  -- A file added to an ALREADY-APPROVED upload has never been reviewed, so it
  -- carries its own status (see this migration's docblock). Hiding just that
  -- file keeps the approved upload and its reviewed files in the feed, instead
  -- of pulling the whole document out over one new attachment. Files that
  -- arrive with a new upload are 'active' — the upload's own review covers them.
  status        text not null default 'active'
                  check (status in ('pending','active','rejected')),
  rejection_reason text,
  reviewed_by   uuid references users (id) on delete set null
);

create index if not exists idx_documents_upload on documents (upload_id);

-- "which files are still waiting for review?" — a tiny slice of the table,
-- so a partial index rather than a full one.
create index if not exists idx_documents_pending
  on documents (upload_id) where status = 'pending';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop table if exists documents cascade;
    `);
  }
}
