import { MigrationInterface, QueryRunner } from 'typeorm';

/** Refresh token store. Depends on users. */
export class CreateRefreshTokens1787616111000 implements MigrationInterface {
  name = 'CreateRefreshTokens1787616111000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
create table if not exists refresh_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_refresh_tokens_user on refresh_tokens (user_id);

-- Drives the retention job below.
create index if not exists idx_refresh_tokens_expires
  on refresh_tokens (expires_at);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop table if exists refresh_tokens cascade;
    `);
  }
}
