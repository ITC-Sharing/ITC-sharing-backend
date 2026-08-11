/**
 * The year levels a major actually has students in — Foundation covers 1–2, the
 * Department of Foreign Languages holds its two languages in the same slot
 * (1 = English, 2 = French), and every department major takes students from
 * year 3 onwards.
 *
 * Mirrors yearLevelsForMajor() in the frontend's utils/format.ts.
 */
export function yearLevelsForMajor(acronym: string): number[] {
  const a = acronym.toLowerCase();
  if (a === 'dfl') return [1, 2];
  if (a === 'foundation') return [1, 2];
  return [3, 4, 5];
}
