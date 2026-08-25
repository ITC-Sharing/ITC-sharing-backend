import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Accounts. Self-referencing on banned_by, and the parent of almost every other
 * table, so it comes immediately after majors.
 *
 * On banning: a ban is a TIMESTAMP rather than a status enum — it records when
 * as well as whether, and "not banned" stays the natural NULL. Banning does not
 * delete the account: uploads, subjects and history stay intact, and unbanning
 * is clearing the columns. Enforcement lives in the API (login, refresh, and
 * every authenticated request), plus revoking the user's refresh tokens so an
 * open session cannot be extended.
 */
export class CreateUsers1787616102000 implements MigrationInterface {
  name = 'CreateUsers1787616102000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table if not exists users (
        id            uuid primary key default gen_random_uuid(),
        first_name    text not null,
        last_name     text not null,
        email         text not null unique,
        password_hash text not null,
        role          text not null default 'user' check (role in ('user','admin')),
        major_id      uuid references majors (id) on delete set null,
        year_level    integer,
        avatar_url    text,
        -- A ban is a timestamp, not a status enum: it records when as well as whether,
        -- and "not banned" stays the natural NULL. The account and its uploads are
        -- kept — unbanning is clearing these. Enforced at login, at refresh, and on
        -- every authenticated request.
        banned_at     timestamptz,
        ban_reason    text,
        banned_by     uuid references users (id) on delete set null,
        created_at    timestamptz not null default now()
      );

      create index if not exists idx_users_major on users (major_id);
          `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop table if exists users cascade;
    `);
  }
}
