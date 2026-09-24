import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets an uploader pin their own document to the top of their dashboard list.
 *
 * A timestamp rather than a boolean, matching hidden_at and banned_at: it
 * records WHEN as well as whether, so several pins order among themselves by
 * most-recently-pinned, and "not pinned" stays the natural NULL.
 *
 * Deliberately NOT applied to the public feed. Pinning is a personal ordering
 * of your own uploads — one user's pin must not reorder what everyone else
 * sees. findAll only honours it when the query is scoped to your own uploads.
 */
export class AddUploadPinnedAt1788307200000 implements MigrationInterface {
  name = 'AddUploadPinnedAt1788307200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table uploads add column if not exists pinned_at timestamptz;

      -- Pinned rows are a small slice, and only ever looked up per uploader.
      create index if not exists idx_uploads_pinned
        on uploads (uploader_id, pinned_at desc) where pinned_at is not null;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop index if exists idx_uploads_pinned;
      alter table uploads drop column if exists pinned_at;
    `);
  }
}
