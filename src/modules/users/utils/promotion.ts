import {
  isFoundationMajor,
  yearLevelsForMajor,
} from '../../documents/utils/year-levels';

/**
 * Students move up a year when an admin schedules a promotion. This module owns
 * that rule; nothing else should reason about the date.
 *
 * There was an automatic 1 July rollover here too. It was removed: the
 * institute's year does not always turn on the same date, and a rule that fires
 * by itself cannot be held back when it should not. Scheduling is now the only
 * way anybody advances — which also means nobody advances until an admin says
 * so.
 *
 * The advance is applied lazily — on the student's next visit after the moment
 * passes, not by a scheduled job. There is no scheduler in this app, and a lazy
 * rule survives the server being down at the appointed time and catches students
 * who were away, which a cron firing once would not.
 */

/**
 * Whether a student is owed the manually scheduled rollover.
 *
 * An admin schedules one instant and every student advances once when it
 * passes. The student's own stamp records which rollover they have already had,
 * so a second one can be scheduled inside the same academic year — something
 * the year-counting rule could not express, because two dates in one year are
 * the same number to it. That is why setting a new date used to advance nobody.
 *
 * Pure, and takes the schedule rather than reading it, so the rule stays
 * testable and the database access stays in one place.
 */
export function isRolloverDue(
  rolloverAt: Date | null,
  appliedAt: Date | null,
  now = new Date(),
): boolean {
  if (!rolloverAt) return false;
  if (rolloverAt > now) return false; // scheduled, not yet reached
  return !appliedAt || appliedAt < rolloverAt;
}

/**
 * The foundation programme's final year is the one that ends in a department,
 * so it cannot be advanced automatically — which department comes next is the
 * student's to say.
 *
 * isFoundationMajor rather than an acronym comparison here: this and the year
 * range have to agree on what counts as foundation, and when they were separate
 * literals a TC student got years 3–5 *and* no prompt.
 */
export function needsDepartmentChoice(
  acronym: string | null | undefined,
  yearLevel: number | null,
): boolean {
  return isFoundationMajor(acronym) && yearLevel === 2;
}

/**
 * The year level a student should be on after `rollovers` promotions.
 *
 * Capped at the major's final year: departments stop at 5, and advancing past
 * it would leave an audience pair no upload can ever target, silently emptying
 * the student's feed. Final-year students simply stay put.
 */
export function advanceYearLevel(
  acronym: string | null | undefined,
  yearLevel: number,
  rollovers: number,
): number {
  const years = yearLevelsForMajor(acronym ?? '');
  const highest = years[years.length - 1];
  return Math.min(yearLevel + rollovers, highest);
}
