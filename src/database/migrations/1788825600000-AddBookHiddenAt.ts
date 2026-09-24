import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets an admin take a book listing out of circulation without deleting it.
 *
 * A timestamp rather than a boolean, matching uploads.hidden_at: it records WHEN
 * as well as whether, and "not hidden" stays the natural NULL.
 *
 * Distinct from `status`, which describes the donation itself (available vs
 * donated). A book can be available and hidden at the same time — that is
 * exactly the moderation case this is for.
 */
export class AddBookHiddenAt1788825600000 implements MigrationInterface {
  name = 'AddBookHiddenAt1788825600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table books add column if not exists hidden_at timestamptz;

      -- The public listing filters on this, and hidden rows are the rare case.
      create index if not exists idx_books_hidden
        on books (hidden_at) where hidden_at is not null;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop index if exists idx_books_hidden;
      alter table books drop column if exists hidden_at;
    `);
  }
}
