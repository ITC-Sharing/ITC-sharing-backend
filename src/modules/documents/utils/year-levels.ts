/**
 * The foundation programme — the first two years, before a student joins a
 * department.
 *
 * `TC` (Tronc Commun) is the current acronym. `FOUNDATION` is the old one, kept
 * here so a database that still carries the previous row keeps behaving, rather
 * than silently offering foundation students years 3–5.
 *
 * Every caller goes through this rather than comparing acronyms itself: the
 * year range and the promotion rule must agree about what "foundation"
 * means, and they used to make that judgement separately.
 */
export function isFoundationMajor(acronym: string | null | undefined): boolean {
  const a = (acronym ?? '').toLowerCase();
  return a === 'tc' || a === 'foundation';
}

/**
 * The year levels a major actually has students in — the foundation programme
 * covers 1–2, the Department of Foreign Languages holds its two languages in
 * the same slot (1 = English, 2 = French), and every department major takes
 * students from year 3 onwards.
 *
 * Mirrors yearLevelsForMajor() in the frontend's utils/format.ts.
 */
export function yearLevelsForMajor(acronym: string): number[] {
  const a = acronym.toLowerCase();
  if (a === 'dfl') return [1, 2];
  if (isFoundationMajor(a)) return [1, 2];
  return [3, 4, 5];
}
