import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drop `users.promoted_for_year`.
 *
 * It recorded the calendar year of the last automatic 1 July rollover. That
 * rule was removed in PromotionSchedule: the institute's year does not always
 * turn on the same date, so promotion became an instant an admin schedules,
 * recorded per student in `promoted_rollover_at`. Counting years could not
 * express two rollovers inside one year — which is why it was replaced, not
 * kept alongside.
 *
 * Nothing has read or written this column since. It survived as "history worth
 * keeping", but it is a year number for a rule that no longer exists, against
 * students whose current progress is fully described by the column that
 * replaced it.
 *
 * The down migration restores the column but not the values. They are not
 * recoverable, and were not consulted by anything while they were here.
 */
export class DropUserPromotedForYear1790208000000 implements MigrationInterface {
  name = 'DropUserPromotedForYear1790208000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table users drop column if exists promoted_for_year;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table users add column if not exists promoted_for_year int;
    `);
  }
}
