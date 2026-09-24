import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reworks book donation from "accept = donated" into a handover flow:
 *
 *   available -> (request) -> pending -> accept -> RESERVED
 *                                      -> receiver confirms -> donated
 *
 * Three things change together, so they belong in one migration:
 *
 *  1. Telegram moves from the book/request rows onto the user. It was stored
 *     per book AND per request, so the same person retyped it every time and
 *     the two copies could disagree. Existing values are backfilled onto the
 *     user before the columns go, so nobody loses their handle.
 *  2. `books.status` gains 'reserved' — accepted but not yet handed over. The
 *     old CHECK allowed only available/donated, which is why accept had to jump
 *     straight to donated.
 *  3. `book_requests` gains 'completed' plus the handover details the donor
 *     supplies on acceptance.
 */
export class BookHandoverFlow1788912000000 implements MigrationInterface {
  name = 'BookHandoverFlow1788912000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table users add column if not exists telegram text;

      -- Backfill from whatever the user last typed, book or request, newest
      -- first. distinct on picks one row per user.
      with latest as (
        select distinct on (user_id) user_id, contact
          from (
            select donor_id     as user_id, contact, created_at   as at from books         where contact is not null and contact <> ''
            union all
            select requester_id as user_id, contact, requested_at as at from book_requests where contact is not null and contact <> ''
          ) c
         order by user_id, at desc
      )
      update users u set telegram = latest.contact
        from latest
       where latest.user_id = u.id and u.telegram is null;

      alter table books drop column if exists contact;
      alter table book_requests drop column if exists contact;

      -- 'reserved': the donor accepted, the handover has not happened yet.
      alter table books drop constraint if exists books_status_check;
      alter table books add constraint books_status_check
        check (status in ('available', 'reserved', 'donated'));

      -- 'completed': the receiver confirmed they physically got the book.
      alter table book_requests drop constraint if exists book_requests_status_check;
      alter table book_requests add constraint book_requests_status_check
        check (status in ('pending', 'accepted', 'declined', 'completed'));

      alter table book_requests
        add column if not exists handover_location text,
        add column if not exists handover_note     text,
        add column if not exists accepted_at       timestamptz,
        add column if not exists completed_at      timestamptz;

      -- Books already 'donated' from the old flow came through an accepted
      -- request; that handover really did happen, so mark those requests
      -- completed rather than leaving them mid-flow under the new rules.
      update book_requests r
         set status = 'completed',
             completed_at = coalesce(r.resolved_at, now()),
             accepted_at  = coalesce(r.accepted_at, r.resolved_at)
        from books b
       where b.id = r.book_id and r.status = 'accepted' and b.status = 'donated';

      -- Only one live request per book — the race two students can otherwise
      -- win together. Partial, so declined/completed rows do not collide.
      create unique index if not exists idx_book_requests_one_active
        on book_requests (book_id) where status in ('pending', 'accepted');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop index if exists idx_book_requests_one_active;

      alter table book_requests
        drop column if exists handover_location,
        drop column if exists handover_note,
        drop column if exists accepted_at,
        drop column if exists completed_at;

      -- Reserved has no equivalent in the old two-state model; those books were
      -- available before they were spoken for.
      update books set status = 'available' where status = 'reserved';
      update book_requests set status = 'accepted' where status = 'completed';

      alter table books drop constraint if exists books_status_check;
      alter table books add constraint books_status_check
        check (status in ('available', 'donated'));

      alter table book_requests drop constraint if exists book_requests_status_check;
      alter table book_requests add constraint book_requests_status_check
        check (status in ('pending', 'accepted', 'declined'));

      -- Restored from the user's profile; NOT NULL on requests as it was.
      alter table books add column if not exists contact text;
      alter table book_requests add column if not exists contact text;
      update books b set contact = u.telegram from users u where u.id = b.donor_id;
      update book_requests r set contact = coalesce(u.telegram, '') from users u where u.id = r.requester_id;
      alter table book_requests alter column contact set not null;

      alter table users drop column if exists telegram;
    `);
  }
}
