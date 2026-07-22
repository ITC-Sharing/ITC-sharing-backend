// Fail fast at boot if a required env var is missing, rather than at first use.
// Services call ConfigService.getOrThrow, which would otherwise only throw on
// the first request that happens to need the missing value. Passed to
// ConfigModule as its `validate` hook.
const REQUIRED = [
  'DATABASE_URL',
  'JWT_SECRET',
  'JWT_SECRET_EXPIRATION_IN',
  'JWT_REFRESH_SECRET',
  'JWT_REFRESH_SECRET_EXPIRATION_IN',
  'S3_ENDPOINT',
  'S3_PUBLIC_URL',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
] as const;

export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const missing = REQUIRED.filter((key) => {
    const value = config[key];
    return value === undefined || value === null || value === '';
  });

  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`,
    );
  }

  return config;
}
