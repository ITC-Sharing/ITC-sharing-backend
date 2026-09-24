import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Moves the promotion rollover from an environment variable into the database,
 * so an admin can set it from the dashboard instead of editing .env and
 * redeploying.
 *
 * `app_settings` is a small key/value store for exactly this kind of thing: one
 * operational value, changed rarely, by a person rather than a deploy.
 *
 * `users.promoted_rollover_at` records WHICH rollover a student has already had
 * applied. The July rule alone could not express this — it counts years, so
 * setting a second date inside the same academic year advanced nobody, and the
 * change looked broken. Stamping the instant makes each configured rollover a
 * distinct event that fires once per student.
 */
export class PromotionSchedule1789430400000 implements MigrationInterface {
  name = 'PromotionSchedule1789430400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table if not exists app_settings (
        key text primary key,
        value text,
        updated_at timestamptz not null default now(),
        updated_by uuid references users(id) on delete set null
      );
    `);

    await queryRunner.query(`
      alter table users
        add column if not exists promoted_rollover_at timestamptz;
    `);

    /**
     * Carry the env value in, if one is set, so the behaviour does not change
     * under anyone mid-flight. Stamped as already-applied for every student who
     * has been promoted past it, because they have: this migration is not a
     * reason to advance anybody a second time.
     */
    const envValue = process.env.PROMOTION_ROLLOVER_AT;
    if (envValue && !Number.isNaN(new Date(envValue).getTime())) {
      await queryRunner.query(
        `insert into app_settings (key, value) values ('promotion_rollover_at', $1)
         on conflict (key) do nothing`,
        [new Date(envValue).toISOString()],
      );
      await queryRunner.query(
        `update users set promoted_rollover_at = $1
          where promoted_for_year is not null and $1::timestamptz <= now()`,
        [new Date(envValue).toISOString()],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `alter table users drop column if exists promoted_rollover_at;`,
    );
    await queryRunner.query(`drop table if exists app_settings;`);
  }
}
