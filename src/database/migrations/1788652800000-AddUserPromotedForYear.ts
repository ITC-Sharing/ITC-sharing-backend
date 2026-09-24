import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records which July rollover has already been applied to a student.
 *
 * Students go up a year every July. Rather than a scheduled job, the advance is
 * applied on the student's next visit, and this column is what makes that
 * idempotent — without it, every request would advance them again.
 *
 * Backfilled to the most recent July for existing rows: they are already on the
 * right year, so the first check after deploy must not move them.
 */
export class AddUserPromotedForYear1788652800000 implements MigrationInterface {
  name = 'AddUserPromotedForYear1788652800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table users add column if not exists promoted_for_year int;

      update users
         set promoted_for_year =
             case when extract(month from now()) >= 7
                  then extract(year from now())::int
                  else extract(year from now())::int - 1
             end
       where promoted_for_year is null;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table users drop column if exists promoted_for_year;
    `);
  }
}
