import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * The shared Redis connection, and the decision about whether there is one.
 *
 * Two subsystems count things that must be counted once per cluster rather than
 * once per process: the rate-limit tiers and the upload byte quota. Both used to
 * hold their counters in this process's memory, which is exactly right for the
 * single container that runs today and quietly wrong for the second one — each
 * replica would grant the full budget independently, and 5-per-15-minutes would
 * become 5 × N.
 *
 * ── Optional on purpose ──────────────────────────────────────────────────
 * With no REDIS_URL there is no client, and both subsystems keep using their
 * in-process counters. That is not a fallback so much as the original design,
 * preserved: a developer running `npm start:dev` should not need a Redis, and a
 * single-replica deployment is not wrong without one. What is wrong is running
 * two replicas without one, and that is what the boot log and the docs are for.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  private readonly url: string | undefined;
  private readonly redis: Redis | null = null;

  /**
   * Whether the last command succeeded. Not a health check — nothing polls —
   * just the most recent evidence, used to log the transition into and out of
   * degraded operation exactly once instead of on every request.
   */
  private healthy = true;

  constructor(config: ConfigService) {
    this.url = config.get<string>('REDIS_URL')?.trim() || undefined;

    if (!this.url) return;

    this.redis = new Redis(this.url, {
      // Bounded queueing, not none.
      //
      // `enableOfflineQueue: false` was the first instinct — fail fast, never
      // wait on a dead server. It has a sharp edge: the socket takes a few
      // milliseconds to open at boot, and every command issued in that window
      // is rejected outright. The process would start, log that Redis was
      // unreachable, and count locally until the first request that happened to
      // arrive late enough. Nothing would look broken.
      //
      // Queueing instead, with maxRetriesPerRequest to bound it: commands
      // issued before the connection is ready are flushed once it is, and
      // commands issued during a real outage fail after one retry rather than
      // piling up behind a reconnect that may never finish.
      enableOfflineQueue: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 3_000,
      // Reconnection itself stays on — the degradation is meant to be
      // temporary, and nothing else in the process will notice it end.
      retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
      lazyConnect: false,
    });

    // `error` must have a listener or ioredis promotes it to an unhandled
    // exception and takes the process down — which is the opposite of
    // degrading gracefully.
    // ioredis hands out ECONNREFUSED with an empty message, which would make
    // the log read "Redis unreachable ()". The code is the useful part anyway.
    this.redis.on('error', (err: Error & { code?: string }) =>
      this.markUnhealthy(err.message || err.code || err.name || 'no detail'),
    );
    this.redis.on('ready', () => this.markHealthy());
  }

  onModuleInit(): void {
    if (!this.url) {
      this.logger.warn(
        'REDIS_URL not set — rate limits and the upload quota are counted ' +
          'per-process. Correct for one replica; running a second would ' +
          'multiply every limit by the number of replicas.',
      );
      return;
    }
    this.logger.log(`Shared counters backed by Redis at ${this.redacted()}`);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redis) await this.redis.quit().catch(() => undefined);
  }

  /**
   * The client, or null when a command should not be attempted.
   *
   * Null means either "no Redis configured here" or "the socket is known to be
   * down right now" — callers treat both the same way, by counting locally.
   *
   * The status check is what keeps an outage cheap. The offline queue holds a
   * command until the next reconnect attempt resolves, and the reconnect
   * backoff grows toward five seconds — so without this, every request during
   * an outage would stall for up to that long before falling back. Measured at
   * ~1s per request on the second call against a dead server.
   *
   * `connecting` is deliberately NOT treated as bad: that is the few
   * milliseconds at boot before the socket opens, and queueing through it is
   * exactly what makes the first requests count correctly.
   */
  get client(): Redis | null {
    if (!this.redis) return null;
    const status = this.redis.status;
    if (status === 'reconnecting' || status === 'end' || status === 'close') {
      return null;
    }
    return this.redis;
  }

  get configured(): boolean {
    return this.redis !== null;
  }

  /**
   * Report a failed command, and say so once.
   *
   * Callers use this to record that they have fallen back to local counting.
   * The logging is edge-triggered because the alternative is one ERROR line per
   * request for as long as the outage lasts, which buries the line that says
   * it ended.
   */
  markUnhealthy(reason: string): void {
    if (!this.healthy) return;
    this.healthy = false;
    this.logger.error(
      `Redis unreachable (${reason}) — counters have fallen back to this ` +
        'process. Limits are now enforced per replica until it returns.',
    );
  }

  markHealthy(): void {
    if (this.healthy) return;
    this.healthy = true;
    this.logger.log('Redis reachable again — counters are shared once more.');
  }

  /** Credentials do not belong in a log line. */
  private redacted(): string {
    try {
      const parsed = new URL(this.url!);
      if (parsed.password) parsed.password = '***';
      if (parsed.username) parsed.username = '***';
      return parsed.toString();
    } catch {
      return 'the configured URL';
    }
  }
}
