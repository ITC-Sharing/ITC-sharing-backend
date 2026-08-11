// Longest acronym the DTOs and the `subjects.acronym` column accept.
export const ACRONYM_MAX_LENGTH = 10;

/**
 * Turn a subject name into its acronym: the first letter of every word,
 * uppercased. A single-word name has no initials to join, so it falls back to
 * its first three characters rather than a lone letter.
 *
 * Splitting and slicing are done over code points, and letters are matched by
 * Unicode class, so a Khmer name yields a usable acronym instead of an empty
 * string. Uppercasing is a no-op for scripts without case.
 */
export function acronymFromName(name: string): string {
  const words = name
    .trim()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean);
  if (!words.length) return '';

  const letters =
    words.length > 1
      ? words.map((word) => [...word][0]).join('')
      : [...words[0]].slice(0, 3).join('');

  return letters.toUpperCase().slice(0, ACRONYM_MAX_LENGTH);
}
