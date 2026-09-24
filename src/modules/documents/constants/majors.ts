// The Department of Foreign Languages runs the English and French courses every
// ITC student takes alongside their own department. Nobody registers into it,
// so no user's major_id is ever DFL, and its `year_level` slot holds the
// language (1 = English, 2 = French) rather than an academic year.
//
// An upload belonging to it therefore carries no audience at all (everyone in
// every year sees it), and it may never appear in another upload's audience —
// that would match no viewer. See DocumentsService.resolveAudience.
//
// Matched by acronym because majors are admin-created rows with no type column.
// If a `kind` column is ever added to `majors`, this is the one place to change.
export const LANGUAGE_MAJOR_ACRONYMS = ['dfl'];
