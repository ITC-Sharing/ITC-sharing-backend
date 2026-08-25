import { MigrationInterface, QueryRunner } from 'typeorm';

/** Per-user notification feed. Depends on users. */
export class CreateNotifications1787616108000 implements MigrationInterface {
  name = 'CreateNotifications1787616108000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
create table if not exists notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users (id) on delete cascade,
  type       text not null,
  message    text not null,
  is_read    boolean not null default false,
  ref_id     uuid,
  ref_type   text,
  created_at timestamptz not null default now()
);

create index if not exists idx_notifications_user_created
  on notifications (user_id, created_at desc);

-- Drives the retention job, which only ever deletes READ notifications.
create index if not exists idx_notifications_read_created
  on notifications (created_at) where is_read;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop table if exists notifications cascade;
    `);
  }
}
