import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Student IDs, and the staging table behind OTP registration.
 *
 * Registration is no longer one request. A student submits their details, gets
 * a 6-digit code by email, and only sets a password once the code proves they
 * own the address. Their answers have to survive between those three requests,
 * and survive a backend restart in the middle — so they live in a table rather
 * than in memory.
 *
 * Nothing lands in `users` until the whole journey completes: an abandoned
 * registration leaves a pending row that expires, not a half-built account.
 */
export class AddStudentIdAndPendingRegistrations1787702400000 implements MigrationInterface {
  name = 'AddStudentIdAndPendingRegistrations1787702400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      -- Nullable: accounts created before this existed have no student ID, and
      -- the seeded admin is not a student at all.
      alter table users add column if not exists student_id text;

      -- Unique on the LOWERCASED value, so e20200123 and E20200123 cannot both
      -- register. Partial, because NULL is not a duplicate — every pre-existing
      -- account has one.
      create unique index if not exists idx_users_student_id
        on users (lower(student_id)) where student_id is not null;

      create table if not exists pending_registrations (
        id             uuid primary key default gen_random_uuid(),
        student_id     text not null,
        -- Derived from student_id, never accepted from the client: the whole
        -- point is that the code goes to an address the student cannot choose.
        email          text not null,
        first_name     text not null,
        last_name      text not null,
        major_id       uuid not null references majors (id) on delete cascade,
        year_level     integer not null,
        -- The code is a credential, so it is stored hashed like a password.
        otp_hash       text not null,
        otp_expires_at timestamptz not null,
        -- Guessing budget. A 6-digit code is only 10^6 wide; without a cap it
        -- is brute-forceable in minutes.
        attempts       integer not null default 0,
        -- Set once the code is accepted. Only a verified row may set a password.
        verified_at    timestamptz,
        -- Drives the resend cooldown, so the endpoint cannot be used to spam
        -- somebody else's inbox.
        last_sent_at   timestamptz not null default now(),
        created_at     timestamptz not null default now(),
        -- One in-flight registration per address; starting again replaces it.
        constraint pending_registrations_email_key unique (email)
      );

      -- The sweep deletes by expiry.
      create index if not exists idx_pending_registrations_expiry
        on pending_registrations (otp_expires_at);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop table if exists pending_registrations;
      drop index if exists idx_users_student_id;
      alter table users drop column if exists student_id;
    `);
  }
}
