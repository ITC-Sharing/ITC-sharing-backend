import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets an account be reached with a Google identity as well as a password.
 *
 * Two changes, both required for the same reason — a Google account has no
 * password of ours:
 *
 *  - `google_id` holds Google's stable subject id, not the email. Emails can be
 *    reassigned; `sub` cannot, so it is the safe thing to match on.
 *  - `password_hash` becomes nullable. A user created through Google has none,
 *    and login() refuses those rather than comparing against a placeholder.
 */
export class AddGoogleAuth1788480000000 implements MigrationInterface {
  name = 'AddGoogleAuth1788480000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table users add column if not exists google_id text;
      alter table users alter column password_hash drop not null;

      -- Partial: only Google-linked rows participate, so the many password-only
      -- accounts don't collide on a shared NULL.
      create unique index if not exists idx_users_google_id
        on users (google_id) where google_id is not null;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop index if exists idx_users_google_id;
      -- Rows without a password cannot satisfy NOT NULL; they only exist
      -- because of Google, so they go with it.
      delete from users where password_hash is null;
      alter table users alter column password_hash set not null;
      alter table users drop column if exists google_id;
    `);
  }
}
