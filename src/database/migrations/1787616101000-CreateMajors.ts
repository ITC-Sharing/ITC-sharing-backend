import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Departments — the root of the reference data. Users, subjects, uploads and
 * books all hang off a major, so nothing else can be created before it.
 *
 * NOTE: this table is left EMPTY — there is deliberately no seed here.
 *
 * That means a fresh database cannot register its first user: RegisterDto
 * requires major_id, and POST /majors is admin-only, so with zero majors nobody
 * can sign up and there is no admin to add one. Insert a department by hand
 * once, then promote the first account — see "First run" in backend/README.md.
 */
export class CreateMajors1787616101000 implements MigrationInterface {
  name = 'CreateMajors1787616101000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table if not exists majors (
        id        uuid primary key default gen_random_uuid(),
        name      text not null,
        acronym   text not null,
        image_url text,
        -- Department pages are resolved by lowercased acronym (the route slug), so a
        -- duplicate would make that lookup ambiguous.
        constraint majors_acronym_key unique (acronym)
      );
          `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop table if exists majors cascade;
    `);
  }
}
