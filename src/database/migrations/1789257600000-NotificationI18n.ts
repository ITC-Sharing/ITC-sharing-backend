import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets a notification be translated on the client.
 *
 * The message was written in English at the moment the event happened, so
 * switching the app to Khmer left every past and future notification in
 * English. These two columns carry what the client needs to build the sentence
 * itself: which phrase, and the values to drop into it.
 *
 * `message` stays, and stays authoritative for rows written before this — the
 * client falls back to it whenever `i18n_key` is null, so no history is lost
 * and nothing has to be back-filled.
 */
export class NotificationI18n1789257600000 implements MigrationInterface {
  name = 'NotificationI18n1789257600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table notifications
        add column if not exists i18n_key text,
        add column if not exists i18n_params jsonb;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table notifications
        drop column if exists i18n_key,
        drop column if exists i18n_params;
    `);
  }
}
