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
  s3: {
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    publicUrl: process.env.S3_PUBLIC_URL,
    accessKey: process.env.S3_ACCESS_KEY,
    secretKey: process.env.S3_SECRET_KEY,
  },
});
