import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets a book belong to no department.
 *
 * Not every donated book is coursework — novels, dictionaries and general
 * reading have no department to file them under, and forcing a choice made
 * donors pick one at random, which is worse than saying nothing.
 *
 * Modelled as a nullable column rather than an "Other" row in `majors`: that
 * table also drives a student's own department and an upload's audience, so a
 * placeholder there would leak into the profile and complete-profile pickers.
 */
export class BookDepartmentOptional1789171200000 implements MigrationInterface {
  name = 'BookDepartmentOptional1789171200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table books alter column major_id drop not null;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Books filed under no department have nowhere to go, so they are removed
    // rather than pointed at an arbitrary one.
    await queryRunner.query(`delete from books where major_id is null;`);
    await queryRunner.query(`
      alter table books alter column major_id set not null;
    `);
  }
}
