import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drop `pending_registrations`.
 *
 * Left over from an OTP draft that was never wired up: no service ever read or
 * wrote the table, and its `student_id` column referenced a users column that
 * was itself dropped in DropUserStudentId. Verification was eventually built as
 * a code against `email_tokens` instead, so this is schema describing a design
 * that does not exist.
 *
 * The down migration recreates the shape for reversibility, but not the data —
 * there was never any worth keeping.
 */
export class DropPendingRegistrations1790035200000 implements MigrationInterface {
  name = 'DropPendingRegistrations1790035200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `drop table if exists pending_registrations cascade;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
create table if not exists pending_registrations (
  id             uuid primary key default gen_random_uuid(),
  student_id     text not null,
  email          text not null,
  first_name     text not null,
  last_name      text not null,
  major_id       uuid not null references majors (id),
  year_level     int not null,
  otp_hash       text not null,
  otp_expires_at timestamptz not null,
  attempts       int not null default 0,
  verified_at    timestamptz,
  last_sent_at   timestamptz not null,
  created_at     timestamptz not null default now()
);
    `);
  }
}
