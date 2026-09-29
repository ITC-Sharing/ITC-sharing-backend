import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { securityHeaders } from './common/security/helmet.config';
import { RedactingLogger } from './common/logging/redacting.logger';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  /**
   * Every log line is scrubbed on its way out, not at the ~50 places that write
   * one. See RedactingLogger: a line is redacted because it is a line, rather
   * than because its author remembered to.
   */
  app.useLogger(new RedactingLogger());

  /**
   * Exactly one proxy hop: nginx terminates TLS and forwards to this process,
   * and nothing else sits in between.
   *
   * The number matters, and `true` is the wrong answer even though it "works".
   * `true` trusts the entire X-Forwarded-For chain, so a caller can prepend a
   * fresh address to every request and give themselves an unlimited number of
   * rate-limit buckets. `1` takes the address nginx wrote and ignores anything
   * the caller put in front of it.
   *
   * This is also why it must match the deployment: with this set to 1 while the
   * API is exposed directly, X-Forwarded-For becomes caller-controlled and the
   * IP-keyed limits can be bypassed outright. Port 3000 is bound to 127.0.0.1
   * in docker-compose.prod.yml for that reason. See docs/rate-limiting.md.
   */
  app.set('trust proxy', 1);

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
