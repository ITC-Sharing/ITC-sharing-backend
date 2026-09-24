import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { securityHeaders } from './common/security/helmet.config';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  /**
   * Proxy trust stays OFF, which is Express's default and is asserted here so
   * the decision is visible rather than inherited.
   *
   * The API is exposed directly today, so `X-Forwarded-For` is written by
   * whoever is calling. Trusting it would let a caller send a fresh address per
   * request and slip every IP-keyed rate limit. When nginx or Caddy is put in
   * front, set this to the exact number of proxy hops — never `true`, which
   * trusts the whole chain and brings the spoofing back. See
   * docs/rate-limiting.md.
   */
  app.set('trust proxy', false);

  /**
   * First in the chain, so the headers are on every response — including CORS
   * preflights and anything a guard rejects before a controller is reached.
   * See common/security/helmet.config.ts for what each one is for.
   */
  app.use(securityHeaders());

  app.use(cookieParser());
  app.enableCors({
    origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(','),
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
