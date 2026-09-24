import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Attempt counter for email tokens.
 *
 * Verification moved from a 32-byte link to a 6-digit code. That is a far
 * smaller secret — one million possibilities, which a script exhausts in
 * minutes — so what makes it safe is no longer the size of the secret but the
 * number of guesses allowed against it. This column is that limit.
 *
 * Reset tokens are untouched and remain links; nothing increments this for them.
 */
export class VerificationCodeAttempts1789948800000 implements MigrationInterface {
  name = 'VerificationCodeAttempts1789948800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
alter table email_tokens
  add column if not exists attempts int not null default 0;

-- Any verification LINK issued before this deploy is now unredeemable: the
-- endpoint that accepted it no longer exists. Consuming them rather than
-- leaving them live keeps the live-token index honest, and anyone holding one
-- falls into the ordinary "request a new code" path instead of a dead link.
update email_tokens
   set consumed_at = now()
 where purpose = 'verify' and consumed_at is null;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
alter table email_tokens drop column if exists attempts;
    `);
  }
}
