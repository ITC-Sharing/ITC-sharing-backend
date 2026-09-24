import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerStorage } from '@nestjs/throttler';
import { RateLimitGuard } from './rate-limit.guard';
import { RedisThrottlerStorage } from './redis-throttler.storage';
import { UploadQuotaService } from './upload-quota.service';

/**
 * Rate limiting, applied to every route.
 *
 * RateLimitGuard decides what gets counted and how; ThrottlerStorage holds the
 * counters and their expiry. Only the interface is borrowed from
 * @nestjs/throttler — `ThrottlerModule` itself is deliberately NOT imported.
 *
 * It used to be, for its storage provider. That does not survive supplying our
 * own: ThrottlerModule is `@Global()`, so its provider for the ThrottlerStorage
 * token shadowed the one declared here and every request kept counting into the
 * in-memory store while the Redis implementation sat unused. A provider for a
 * token a global module also provides is not an override — it is a coin toss,
 * and this one landed the wrong way silently.
 *
 * STORAGE: Redis when REDIS_URL is set, this process's memory otherwise. The
 * swap is this one provider — the guard depends on the ThrottlerStorage
 * interface, so no tier, controller or test changed when it happened, which is
 * what depending on the interface was for.
 *
 * Without Redis the counters are per-process: correct for the single container
 * that runs today, and wrong the moment a second one starts, because each
 * replica would enforce every limit independently and 5-per-15-minutes would
 * become 5 × N. See docs/rate-limiting.md.
 */
@Module({
  imports: [
    // For reading `sub` out of the access token: a global guard runs before the
    // route's JwtAuthGuard, so per-user counters have to identify the caller
    // themselves. See RateLimitGuard.userIdOf.
    ConfigModule,
    JwtModule.register({}),
  ],
  providers: [
    // The only provider for this token anywhere in the app. Asserted by
    // rate-limit.wiring.spec.ts, because the failure mode is silent: the guard
    // keeps working, on the wrong store.
    { provide: ThrottlerStorage, useClass: RedisThrottlerStorage },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    // Byte budget for uploads. Lives here because it is the same kind of
    // control as the tiers above and shares their single-instance caveat.
    UploadQuotaService,
  ],
  exports: [UploadQuotaService],
})
export class RateLimitModule {
  constructor(private readonly quota: UploadQuotaService) {
    // Expired windows would otherwise accumulate one entry per user forever.
    // unref() so this timer never holds the process open.
    setInterval(() => this.quota.prune(), 10 * 60_000).unref();
  }
}
