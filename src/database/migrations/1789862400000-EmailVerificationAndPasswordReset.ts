import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Email verification and password reset.
 *
 * Until now the password path never proved that the person registering owned
 * the address they typed — only the Google path did, because Google vouches for
 * it. Anyone could sign up as anyone, and there was no way back into an account
 * whose password was forgotten.
 *
 * ── Two columns and one table ────────────────────────────────────────────
 * `users.email_verified_at` is the fact. Null means the address is unproven.
 *
 * `email_tokens` holds the one-time secrets for both flows. One table with a
 * `purpose` rather than two: the lifecycle is identical — issue, email, redeem
 * once, expire — and two tables would mean two copies of the same expiry and
 * single-use logic, which is how one of them ends up missing a check.
 *
 * Only the SHA-256 of each token is stored, exactly as refresh tokens are. A
 * database leak must not hand over the ability to take over accounts, and a
 * reset token is precisely that ability.
 *
 * ── Everyone who already exists is verified ──────────────────────────────
 * Backfilled deliberately. These accounts were created under rules that did not
 * ask for proof, and applying a new rule retroactively would lock out every
 * existing student on the morning of the deploy to fix a risk that was taken
 * months ago. The rule binds from here forward.
 */
export class EmailVerificationAndPasswordReset1789862400000 implements MigrationInterface {
  name = 'EmailVerificationAndPasswordReset1789862400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
alter table users
  add column if not exists email_verified_at timestamptz;

-- Grandfathered: see the note above. Google accounts would be verified anyway.
update users set email_verified_at = now() where email_verified_at is null;

create table if not exists email_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  -- 'verify' proves the address; 'reset' authorises a new password.
  purpose     text not null check (purpose in ('verify', 'reset')),
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  -- Set the moment it is redeemed. Kept rather than deleted so a second use is
  -- recognisable as a replay instead of looking like a token that never was.
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);

-- Redeeming is a lookup by hash; that is the unique index above. These two
-- serve the other paths: "this user's live tokens" when a new one supersedes
-- the old, and the expiry sweep.
create index if not exists idx_email_tokens_user_purpose
  on email_tokens (user_id, purpose) where consumed_at is null;

create index if not exists idx_email_tokens_expires
  on email_tokens (expires_at);
    `);

    // Expired rows ride along with the existing retention job rather than
    // needing a second scheduler. Recreated with the extra delete rather than
    // altered, since a plpgsql body cannot be patched in place.
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

  -- Verification and reset tokens. Not counted in the return value, which is
  -- part of this function's signature and read by whatever calls it.
  delete from email_tokens where expires_at < now();

  return query select tokens, notes;
end $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
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

  delete from notifications
   where is_read and created_at < now() - notification_retention;
  get diagnostics notes = row_count;

  return query select tokens, notes;
end $$;
    `);

    await queryRunner.query(`
drop table if exists email_tokens cascade;
alter table users drop column if exists email_verified_at;
    `);
  }
}
