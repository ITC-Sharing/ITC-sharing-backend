import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drop `users.banned_at`, `ban_reason` and `banned_by`.
 *
 * UserBanHistory added `user_bans` and left these in place, so the ban in force
 * was stored twice and banUser/unbanUser needed a transaction to keep the two
 * agreeing. The reason given for keeping them was the cost of the join on the
 * authentication path — measured afterwards, and wrong: the partial index the
 * join probes contains only accounts actually banned, so it is nearly empty and
 * the lookup is indistinguishable from reading the column.
 *
 * With no cost to weigh against it, one fact stored once wins. `user_bans` is
 * now the only place a ban is recorded, and the question "is this account
 * banned?" is answered by the absence of an unlifted row.
 *
 * Safe in this order because UserBanHistory already copied every ban in force
 * into the table. Nothing is read from these columns by the time this runs.
 */
export class DropUserBanColumns1790294400000 implements MigrationInterface {
  name = 'DropUserBanColumns1790294400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * Belt and braces: UserBanHistory backfilled, but a ban issued between the
     * two migrations would exist only as a column. Re-running the copy costs
     * nothing — the partial unique index makes a duplicate impossible.
     */
    await queryRunner.query(`
      insert into user_bans (user_id, reason, banned_by, banned_at)
      select id, ban_reason, banned_by, banned_at
        from users
       where banned_at is not null
         and not exists (select 1
                           from user_bans b
                          where b.user_id = users.id
                            and b.lifted_at is null);
    `);

    await queryRunner.query(`
      alter table users
        drop column if exists banned_at,
        drop column if exists ban_reason,
        drop column if exists banned_by;
    `);
  }

  /**
   * Restores the columns and repopulates them from the bans in force, so a
   * rollback lands on a working system rather than an empty flag that would
   * silently let every banned account back in.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table users
        add column if not exists banned_at timestamptz,
        add column if not exists ban_reason text,
        add column if not exists banned_by uuid;
    `);

    await queryRunner.query(`
      update users u
         set banned_at = b.banned_at,
             ban_reason = b.reason,
             banned_by = b.banned_by
        from user_bans b
       where b.user_id = u.id
         and b.lifted_at is null;
    `);
  }
}
