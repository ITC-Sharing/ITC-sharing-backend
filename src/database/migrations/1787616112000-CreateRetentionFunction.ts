import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * purge_expired_data() — reads refresh_tokens and notifications, so it comes
 * after both. Nothing calls it automatically; schedule it with cron.
 */
export class CreateRetentionFunction1787616112000 implements MigrationInterface {
  name = 'CreateRetentionFunction1787616112000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
create or replace function purge_expired_data(
  notification_retention interval default '90 days'
)
returns table (refresh_tokens_deleted bigint, notifications_deleted bigint)
language plpgsql
as $$
declare
  tokens bigint;
  notes  bigint;
begin
  delete from refresh_tokens where expires_at < now();
  get diagnostics tokens = row_count;

  -- Unread notifications are kept regardless of age — the user hasn't seen them.
  delete from notifications
   where is_read and created_at < now() - notification_retention;
  get diagnostics notes = row_count;

  return query select tokens, notes;
end $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop function if exists purge_expired_data(interval);
    `);
  }
}
