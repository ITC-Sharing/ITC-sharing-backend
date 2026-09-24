import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Removes the student ID from accounts entirely.
 *
 * It was introduced when registration derived the institute email from it. Both
 * of those are gone — sign-up takes a typed email, and Google accounts never had
 * one — leaving a column that nothing wrote and nothing read.
 *
 * Destructive: the stored IDs go with the column. `down` restores the shape but
 * not the values, since a dropped column keeps nothing to restore from.
 */
export class DropUserStudentId1788566400000 implements MigrationInterface {
  name = 'DropUserStudentId1788566400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop index if exists idx_users_student_id;
      alter table users drop column if exists student_id;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table users add column if not exists student_id text;

      create unique index if not exists idx_users_student_id
        on users (lower(student_id)) where student_id is not null;
    `);
  }
}
