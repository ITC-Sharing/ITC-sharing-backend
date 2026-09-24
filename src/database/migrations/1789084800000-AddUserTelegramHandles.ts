import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets a student keep more than one Telegram account.
 *
 * `users.telegram` held exactly one handle, so adding a second overwrote the
 * first. It now names whichever saved handle is currently in use, and this
 * column holds the whole set — the donor picks one when accepting a request,
 * the way a delivery app offers saved addresses.
 *
 * The existing handle is carried in as the first saved one, so nobody has to
 * retype what they already gave us.
 */
export class AddUserTelegramHandles1789084800000 implements MigrationInterface {
  name = 'AddUserTelegramHandles1789084800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table users
        add column if not exists telegram_handles text[] not null default '{}';
    `);

    // Backfill, guarded so re-running cannot duplicate an entry.
    await queryRunner.query(`
      update users
         set telegram_handles = array[telegram]
       where telegram is not null
         and telegram <> ''
         and cardinality(telegram_handles) = 0;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // `telegram` still holds the handle in use, so dropping the list loses only
    // the alternatives.
    await queryRunner.query(`
      alter table users drop column if exists telegram_handles;
    `);
  }
}
