import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Who reviews which department. Depends on users and majors.
 *
 * Review used to be all-or-nothing: only `users.role = 'admin'` could approve
 * anything, for every department. A moderator reviews only the departments they
 * are assigned to — one row per assignment, so one person can cover several and
 * one department can have several people.
 *
 * Deliberately a TABLE rather than a `users.role = 'moderator'` value: the role
 * alone cannot say WHICH department, and reusing `users.major_id` would
 * conflate "studies here" with "reviews here" — which would also leave DFL
 * unmoderatable, since nobody registers into it as a department.
 *
 * Admins keep blanket access, so a department with no moderator is never stuck.
 */
export class CreateDepartmentModerators1787616107000 implements MigrationInterface {
  name = 'CreateDepartmentModerators1787616107000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
create table if not exists department_moderators (
  user_id    uuid not null references users (id) on delete cascade,
  major_id   uuid not null references majors (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, major_id)
);

-- "who moderates this department?" — the review queue asks this constantly.
create index if not exists idx_department_moderators_major
  on department_moderators (major_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop table if exists department_moderators cascade;
    `);
  }
}
