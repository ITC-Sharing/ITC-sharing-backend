import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Finishes the handover flow: a reservation can now end without a handover.
 *
 *  - 'cancelled' — either side called it off.
 *  - 'expired'   — nobody acted within the reservation window, so a scheduled
 *                  job released the book. Without this a receiver who never
 *                  turns up locks a book away permanently.
 *
 * The handover columns go: where and when is settled on Telegram, so storing a
 * location or note here only duplicated the conversation.
 */
export class BookRequestCancelExpire1788998400000 implements MigrationInterface {
  name = 'BookRequestCancelExpire1788998400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table book_requests drop constraint if exists book_requests_status_check;
      alter table book_requests add constraint book_requests_status_check
        check (status in ('pending', 'accepted', 'declined', 'cancelled', 'expired', 'completed'));

      alter table book_requests
        add column if not exists cancelled_at timestamptz,
        add column if not exists expired_at   timestamptz,
        drop column if exists handover_location,
        drop column if exists handover_note;

      -- The expiry sweep scans accepted rows by age; without this it is a table
      -- scan on every run.
      create index if not exists idx_book_requests_accepted_at
        on book_requests (accepted_at) where status = 'accepted';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop index if exists idx_book_requests_accepted_at;

      -- Neither state exists in the older model; both meant the book went back
      -- on the shelf, which is what 'declined' recorded before.
      update book_requests set status = 'declined'
       where status in ('cancelled', 'expired');

      alter table book_requests
        drop column if exists cancelled_at,
        drop column if exists expired_at,
        add column if not exists handover_location text,
        add column if not exists handover_note text;

      alter table book_requests drop constraint if exists book_requests_status_check;
      alter table book_requests add constraint book_requests_status_check
        check (status in ('pending', 'accepted', 'declined', 'completed'));
    `);
  }
}
