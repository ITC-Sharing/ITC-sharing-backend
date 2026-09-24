import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-file hiding, alongside the upload-level `uploads.hidden_at`.
 *
 * Two levels because they answer different questions: hiding an upload takes
 * the whole folder out of circulation, hiding a file removes one attachment
 * while the rest stay up.
 *
 * Not reusing `documents.status`, for the same reason `uploads.hidden_at` is
 * not a status value: status is the REVIEW state, and a hidden file is still
 * approved. Folding them together would send a file back through moderation
 * when it is un-hidden.
 *
 * The service keeps one invariant: hiding the LAST visible file also hides its
 * upload, because a folder with nothing visible in it is not something the feed
 * can render — the same rule `removeFile` applies when deleting the last file.
 */
export class AddDocumentHiddenAt1787964000000 implements MigrationInterface {
  name = 'AddDocumentHiddenAt1787964000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table documents add column if not exists hidden_at timestamptz;

      -- Every feed query excludes hidden files, and they are a small slice.
      create index if not exists idx_documents_hidden
        on documents (upload_id) where hidden_at is not null;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop index if exists idx_documents_hidden;
      alter table documents drop column if exists hidden_at;
    `);
  }
}
