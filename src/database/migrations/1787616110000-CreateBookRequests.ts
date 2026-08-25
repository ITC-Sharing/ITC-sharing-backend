import { MigrationInterface, QueryRunner } from 'typeorm';

/** Requests against a donated book. Depends on books and users. */
export class CreateBookRequests1787616110000 implements MigrationInterface {
  name = 'CreateBookRequests1787616110000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
create table if not exists book_requests (
  id             uuid primary key default gen_random_uuid(),
  book_id        uuid not null references books (id) on delete cascade,
  requester_id   uuid not null references users (id) on delete cascade,
  message        text,
  contact        text not null,
  status         text not null default 'pending'
                   check (status in ('pending','accepted','declined')),
  requested_at   timestamptz not null default now(),
  resolved_at    timestamptz,
  decline_reason text
);

create index if not exists idx_book_requests_book on book_requests (book_id);
create index if not exists idx_book_requests_requester
  on book_requests (requester_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop table if exists book_requests cascade;
    `);
  }
}
