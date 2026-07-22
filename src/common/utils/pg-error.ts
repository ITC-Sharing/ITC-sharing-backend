// Helpers for inspecting errors thrown by the pg driver / TypeORM.
// TypeORM wraps driver errors in QueryFailedError but copies the SQLSTATE
// `code` onto the error object; fall back to `driverError.code` just in case.

interface PgLikeError {
  code?: string;
  message?: string;
  driverError?: { code?: string };
}

function asPgError(err: unknown): PgLikeError {
  return (err ?? {}) as PgLikeError;
}

/** Postgres SQLSTATE code (e.g. '23505' unique, '23503' FK), if present. */
export function pgCode(err: unknown): string | undefined {
  const e = asPgError(err);
  return e.code ?? e.driverError?.code;
}

/** Best-effort error message string. */
export function errMessage(err: unknown): string {
  const e = asPgError(err);
  return e.message ?? 'unknown error';
}
