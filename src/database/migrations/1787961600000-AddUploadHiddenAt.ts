import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets an uploader take a document out of circulation without deleting it.
 *
 * Deliberately NOT a `uploads.status` value: status is the REVIEW state
 * (pending → active/rejected), and a hidden document is still approved — it is
 * simply not on display. Folding the two together would mean un-hiding sends a
 * document back through moderation, and would break the review queue's
 * `status = 'pending'` query.
 *
 * Deliberately not `expires_at` either, though that already hides things:
 * expiry is a date the uploader schedules, hiding is a switch they flip. Using
 * one for both makes "Expired" and "Hidden" indistinguishable in the UI, and
 * they collide the moment a hidden document also has a real expiry set.
 *
 * A timestamp rather than a boolean, matching `banned_at` — it records WHEN as
 * well as whether, and "visible" stays the natural NULL.
 */
export class AddUploadHiddenAt1787961600000 implements MigrationInterface {
  name = 'AddUploadHiddenAt1787961600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table uploads add column if not exists hidden_at timestamptz;

      -- The feed excludes hidden uploads on every query, and they are a small
      -- slice of the table — partial index, not a full one.
      create index if not exists idx_uploads_hidden
        on uploads (uploader_id) where hidden_at is not null;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop index if exists idx_uploads_hidden;
      alter table uploads drop column if exists hidden_at;
    `);
  }
}
