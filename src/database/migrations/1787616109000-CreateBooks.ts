import { MigrationInterface, QueryRunner } from 'typeorm';

/** Book donations. Depends on users and majors. */
export class CreateBooks1787616109000 implements MigrationInterface {
  name = 'CreateBooks1787616109000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
create table if not exists books (
  id              uuid primary key default gen_random_uuid(),
  donor_id        uuid not null references users (id) on delete cascade,
  major_id        uuid not null references majors (id) on delete cascade,
  title           text not null,
  description     text,
  contact         text,
  cover_image_url text,
  status          text not null default 'available'
                    check (status in ('available','donated')),
  created_at      timestamptz not null default now()
);

create index if not exists idx_books_donor on books (donor_id);
create index if not exists idx_books_major_status on books (major_id, status);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop table if exists books cascade;
    `);
  }
}
