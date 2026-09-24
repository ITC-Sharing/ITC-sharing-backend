import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Refresh-token reuse detection.
 *
 * Rotation used to DELETE the redeemed row, which threw away the only evidence
 * that the token had ever existed. A stolen token replayed after the victim had
 * moved on simply got a 401 — indistinguishable from an expired one, and
 * nothing anywhere recorded that a credential had been used twice.
 *
 * Two columns change that:
 *
 * - `consumed_at` keeps the redeemed row instead of deleting it, so a second
 *   presentation is recognisable as a replay rather than a stranger. The row
 *   still carries its original `expires_at`, so purge_expired_data() clears it
 *   on the same schedule as before — reuse is detectable for exactly as long as
 *   the token could have been accepted, and not a day longer.
 *
 * - `family_id` is the lineage a token belongs to: one per sign-in, inherited by
 *   every rotation. Detecting reuse is only useful if the response can revoke
 *   the descendants too, and without this there is no way to name them.
 */
export class RefreshTokenFamilies1789776000000 implements MigrationInterface {
  name = 'RefreshTokenFamilies1789776000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
alter table refresh_tokens
  add column if not exists family_id uuid,
  add column if not exists consumed_at timestamptz;

-- Every token that predates this migration becomes its own family. They are
-- live, unconsumed leaves, so a family of one is exactly what they are.
update refresh_tokens set family_id = gen_random_uuid() where family_id is null;

alter table refresh_tokens alter column family_id set not null;

-- Revoking a family is the write on the detection path; it has to be one index
-- hit, not a scan of every token in the table.
create index if not exists idx_refresh_tokens_family
  on refresh_tokens (family_id);

-- The live-token lookup is now "this hash, not yet consumed". token_hash is
-- already unique, so this is about keeping the consumed rows out of the way as
-- they accumulate.
create index if not exists idx_refresh_tokens_live
  on refresh_tokens (token_hash) where consumed_at is null;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
drop index if exists idx_refresh_tokens_live;
drop index if exists idx_refresh_tokens_family;

-- Before the column goes, not after: the pre-migration code treats every row
-- present as usable, so a consumed row left behind would resurrect a token that
-- had already been rotated away — and once consumed_at is dropped there is no
-- way left to tell which those are.
delete from refresh_tokens where consumed_at is not null;

alter table refresh_tokens
  drop column if exists consumed_at,
  drop column if exists family_id;
    `);
  }
}
