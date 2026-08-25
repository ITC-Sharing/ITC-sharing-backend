import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extensions every later migration depends on, so this runs first.
 *
 * pgcrypto supplies gen_random_uuid(), the default for every primary key;
 * pg_trgm backs the GIN trigram indexes that make ILIKE '%term%' title and
 * description search something other than a full table scan.
 */
export class EnableExtensions1787616100000 implements MigrationInterface {
  name = 'EnableExtensions1787616100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create extension if not exists pgcrypto;
      create extension if not exists pg_trgm;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop extension if exists pg_trgm;
      drop extension if exists pgcrypto;
    `);
  }
}
