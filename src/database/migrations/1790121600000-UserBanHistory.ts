import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Keep a permanent record of every ban, instead of only the current one.
 *
 * `users.banned_at` / `ban_reason` / `banned_by` describe the ban in force, and
 * unbanning nulled all three — so lifting a ban destroyed the only evidence it
 * ever happened. An admin deciding whether to ban someone could not see that
 * the same account had been banned twice before, which is exactly the context
 * that decision wants.
 *
 * Those three columns STAY. `banned_at` is read on every authenticated request
 * by the JWT strategy, and again on login, refresh and the notification
 * fan-out; answering "is this account banned?" from a log would put a join
 * ordering rows by date into the hottest read in the app, to serve a screen
 * that is opened rarely. So the flag remains the source of truth for access
 * control and this table is the history beside it — a deliberate duplication,
 * written in the same transaction by banUser/unbanUser.
 *
 * Append-only: unbanning stamps `lifted_at`, it does not delete the row.
 */
export class UserBanHistory1790121600000 implements MigrationInterface {
  name = 'UserBanHistory1790121600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * banned_by / lifted_by are `set null` rather than `cascade`: deleting the
     * admin who issued a ban must not erase the record that the ban happened.
     * user_id cascades, because a ban on a deleted account describes nothing.
     */
    await queryRunner.query(`
      create table if not exists user_bans (
        id         uuid primary key default gen_random_uuid(),
        user_id    uuid not null references users (id) on delete cascade,
        reason     text,
        banned_by  uuid references users (id) on delete set null,
        banned_at  timestamptz not null default now(),
        lifted_at  timestamptz,
        lifted_by  uuid references users (id) on delete set null
      );
    `);

    /** The history screen reads one user's bans, newest first. */
    await queryRunner.query(`
      create index if not exists idx_user_bans_user
        on user_bans (user_id, banned_at desc);
    `);

    /**
     * At most one ban in force per user, enforced rather than assumed — a
     * second open row would make "which ban is this?" unanswerable, and would
     * mean the flag on users had drifted from the log.
     */
    await queryRunner.query(`
      create unique index if not exists idx_user_bans_active
        on user_bans (user_id)
        where lifted_at is null;
    `);

    /**
     * Seed the log from the bans currently in force, so accounts banned before
     * this migration are not missing their opening row. Only unlifted bans
     * exist to copy — the lifted ones were already destroyed, and nothing here
     * can bring them back.
     */
    await queryRunner.query(`
      insert into user_bans (user_id, reason, banned_by, banned_at)
      select id, ban_reason, banned_by, banned_at
        from users
       where banned_at is not null
      on conflict do nothing;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists user_bans;`);
  }
}
