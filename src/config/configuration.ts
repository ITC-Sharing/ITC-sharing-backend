// A typed view over the environment, loaded into ConfigModule. Reading through
// these keys is optional — services may still call ConfigService.get('X') — but
// this keeps the shape the app expects documented in one place.
export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  databaseUrl: process.env.DATABASE_URL,
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_SECRET_EXPIRATION_IN,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    refreshExpiresIn: process.env.JWT_REFRESH_SECRET_EXPIRATION_IN,
  },
  /** Which deployment this is. Printed on every developer alert. */
  appEnv: process.env.APP_ENV ?? 'development',
  /**
   * Developer alerts. A SECOND bot, separate from the student-facing one in
   * TelegramService: one outage or revoked token must not take out both, and a
   * bug in the student path must not be able to address the developer chat.
   */
  devAlerts: {
    botToken: process.env.TELEGRAM_ALERT_BOT_TOKEN,
    chatId: process.env.TELEGRAM_DEVELOPER_CHAT_ID,
    enabled: process.env.TELEGRAM_ALERTS_ENABLED,
    includeCodes: process.env.TELEGRAM_ALERTS_INCLUDE_CODES,
  },
  s3: {
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    publicUrl: process.env.S3_PUBLIC_URL,
    accessKey: process.env.S3_ACCESS_KEY,
    secretKey: process.env.S3_SECRET_KEY,
  },
});
