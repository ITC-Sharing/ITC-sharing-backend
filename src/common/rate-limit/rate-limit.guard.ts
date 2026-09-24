import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerStorage } from '@nestjs/throttler';
import { createHash } from 'crypto';
import type { Request, Response } from 'express';
import {
  defaultTierForMethod,
  RATE_LIMIT_MESSAGE,
  RATE_LIMIT_TIERS,
  type RateLimitRule,
  type RateLimitTierName,
} from './rate-limit.config';
import { RATE_LIMIT_TIER } from './rate-limit.decorator';

type MaybeAuthed = Request & { user?: { sub?: string } };

/** Set by the auth controller; read here only to tell one caller from another. */
const REFRESH_COOKIE = 'refresh_token';

/**
 * The one place a request is counted.
 *
 * Built on ThrottlerStorage rather than by extending ThrottlerGuard, because
 * that guard applies every configured throttler to every route — which is the
 * opposite of what named tiers are for. Depending only on the storage interface
 * also keeps the Redis migration to a provider swap: nothing here knows whether
 * the counters live in this process or not.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger('RateLimit');

  private readonly jwtSecret: string | undefined;
  private readonly refreshSecret: string | undefined;

  constructor(
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.jwtSecret = config.get<string>('JWT_SECRET');
    this.refreshSecret = config.get<string>('JWT_REFRESH_SECRET');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const http = context.switchToHttp();
    const req = http.getRequest<MaybeAuthed>();
    const res = http.getResponse<Response>();

    const tier = this.resolveTier(context, req.method);
    const rules: readonly RateLimitRule[] = RATE_LIMIT_TIERS[tier];

    // The counter closest to its limit is the one worth reporting, so the
    // headers describe the constraint the caller will actually hit first.
    let tightest: {
      rule: RateLimitRule;
      remaining: number;
      resetSeconds: number;
    } | null = null;

    for (const rule of rules) {
      const tracker = this.trackerFor(rule, req);
      const key = `${rule.name}:${tracker}`;
      const record = await this.storage.increment(
        key,
        rule.ttlMs,
        rule.limit,
        // Block for a full window once the limit is passed. Zero looks like
        // "no cool-off" but means the opposite: the store unblocks and resets
        // the counter on the same call, so the limit can never be exceeded and
        // nothing is ever refused.
        rule.ttlMs,
        rule.name,
      );

      // Both figures come back in seconds, not milliseconds.
      const resetSeconds = record.isBlocked
        ? record.timeToBlockExpire
        : record.timeToExpire;
      const remaining = Math.max(0, rule.limit - record.totalHits);
      if (!tightest || remaining < tightest.remaining) {
        tightest = { rule, remaining, resetSeconds };
      }

      if (record.isBlocked || record.totalHits > rule.limit) {
        this.reject(req, res, tier, rule, resetSeconds);
      }
    }

    if (tightest) {
      // RFC 9331 draft spelling, which is what most clients and proxies read.
      res.setHeader('RateLimit-Limit', String(tightest.rule.limit));
      res.setHeader('RateLimit-Remaining', String(tightest.remaining));
      res.setHeader(
        'RateLimit-Reset',
        String(this.clampSeconds(tightest.resetSeconds)),
      );
    }

    return true;
  }

  /** Route metadata, then controller metadata, then whatever the method implies. */
  private resolveTier(
    context: ExecutionContext,
    method: string,
  ): RateLimitTierName {
    return (
      this.reflector.getAllAndOverride<RateLimitTierName>(RATE_LIMIT_TIER, [
        context.getHandler(),
        context.getClass(),
      ]) ?? defaultTierForMethod(method)
    );
  }

  private trackerFor(rule: RateLimitRule, req: MaybeAuthed): string {
    const ip = RateLimitGuard.resolveIp(req);
    switch (rule.key) {
      case 'user': {
        // No session — an unauthenticated write still has to be bounded, so
        // fall back to the address rather than letting it through uncounted.
        const userId = this.userIdOf(req);
        return userId ? `user:${userId}` : `ip:${ip}`;
      }
      case 'refresh-user': {
        const userId = this.refreshUserIdOf(req);
        return userId ? `user:${userId}` : `ip:${ip}`;
      }
      case 'ip-email':
        return `ipmail:${ip}:${RateLimitGuard.emailFingerprint(req)}`;
      case 'ip':
      default:
        return `ip:${ip}`;
    }
  }

  /**
   * Who is calling, as far as the token can be trusted.
   *
   * A global guard runs BEFORE the route's JwtAuthGuard, so `req.user` is still
   * empty here — reading it would quietly key every "per user" limit by address
   * instead, and nobody would notice until two students behind one NAT started
   * sharing a budget.
   *
   * The signature is verified rather than merely decoded. An unverified `sub`
   * is attacker-chosen: it would let one caller spend someone else's budget, or
   * mint a fresh identity per request and never be limited at all. A failed
   * verification is not an error here — the route's real auth guard will answer
   * that — it just means this request is counted by address.
   */
  private userIdOf(req: MaybeAuthed): string | null {
    if (req.user?.sub) return req.user.sub; // already authenticated upstream
    if (!this.jwtSecret) return null;

    const header = req.headers?.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer '))
      return null;

    try {
      const payload = this.jwt.verify<{ sub?: string }>(header.slice(7), {
        secret: this.jwtSecret,
      });
      return typeof payload.sub === 'string' ? payload.sub : null;
    } catch {
      return null;
    }
  }

  /**
   * Who the refresh cookie belongs to.
   *
   * `/auth/refresh` is the one per-user route with nothing in the Authorization
   * header — the access token it is being called to replace is expired or was
   * never there. The cookie is the only identity on the request, so it is what
   * the counter has to read.
   *
   * Verified, not decoded, for the same reason userIdOf verifies: an unverified
   * `sub` is attacker-chosen, and a forged one would either spend someone
   * else's budget or mint a fresh identity per request. A cookie that does not
   * verify is counted by address, and the route will refuse it anyway.
   *
   * The token itself rotates on every use, so it cannot be the key — a new
   * value each call is a new counter, which is no limit at all. `sub` is the
   * part that stays still.
   */
  private refreshUserIdOf(req: MaybeAuthed): string | null {
    if (!this.refreshSecret) return null;

    // Same read as the auth controller's: cookie-parser is global middleware,
    // and middleware runs before guards.
    const cookies = req.cookies as Record<string, string> | undefined;
    const raw = cookies?.[REFRESH_COOKIE];
    if (!raw) return null;

    try {
      const payload = this.jwt.verify<{ sub?: string }>(raw, {
        secret: this.refreshSecret,
      });
      return typeof payload.sub === 'string' ? payload.sub : null;
    } catch {
      return null;
    }
  }

  /**
   * The socket address, never a forwarded header.
   *
   * The API is exposed directly today, so `X-Forwarded-For` is written by
   * whoever is calling: read it and an attacker rotates a fresh value per
   * request and no limit ever trips. `req.socket.remoteAddress` cannot be
   * spoofed that way, and unlike `req.ip` it does not change meaning if someone
   * later switches Express's `trust proxy` on.
   *
   * When a reverse proxy IS introduced, this is the function to change — and
   * `trust proxy` must be set to the exact hop count at the same time. See
   * docs/rate-limiting.md.
   */
  static resolveIp(req: Request): string {
    const raw = req.socket?.remoteAddress ?? 'unknown';
    // ::ffff:127.0.0.1 and 127.0.0.1 are the same caller.
    return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  }

  /**
   * A stable stand-in for the account being addressed.
   *
   * Hashed, and truncated, because this string ends up in a counter key and in
   * memory for the length of the window — there is no reason for either to hold
   * a readable address. Normalised first so `A@x.com ` and `a@x.com` cannot be
   * used as two separate budgets against the same account.
   */
  private static emailFingerprint(req: Request): string {
    const body = req.body as { email?: unknown } | undefined;
    const email = typeof body?.email === 'string' ? body.email : '';
    const normalised = email.trim().toLowerCase();
    if (!normalised) return 'anonymous';
    return createHash('sha256').update(normalised).digest('hex').slice(0, 16);
  }

  /** Never advertise a wait of zero — a client would retry straight into another 429. */
  private clampSeconds(seconds: number): number {
    return Math.max(1, Math.ceil(seconds));
  }

  /**
   * Refuse the request.
   *
   * The body says when to come back and nothing else: which rule tripped, what
   * the limit is, and whether the account exists are all things an attacker
   * would rather know. `success: false` and `statusCode` keep it readable by the
   * frontend's existing error handling, which reads `data.message`.
   */
  private reject(
    req: MaybeAuthed,
    res: Response,
    tier: RateLimitTierName,
    rule: RateLimitRule,
    resetSeconds: number,
  ): never {
    const retryAfter = this.clampSeconds(resetSeconds);
    res.setHeader('Retry-After', String(retryAfter));
    res.setHeader('RateLimit-Limit', String(rule.limit));
    res.setHeader('RateLimit-Remaining', '0');
    res.setHeader('RateLimit-Reset', String(retryAfter));

    // Metadata only. No key, no user id, no address, no body — the kind of
    // counter is enough to tell which rule is misconfigured, and anything more
    // would put identifiers in the log for every failed login attempt.
    this.logger.warn(
      `rate limit exceeded tier=${tier} rule=${rule.name} key=${rule.key} ` +
        `${req.method} ${RateLimitGuard.routeOf(req)} retry_after=${retryAfter}s`,
    );

    throw new HttpException(
      {
        success: false,
        message: RATE_LIMIT_MESSAGE,
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** Path without the query string — which can carry search terms. */
  private static routeOf(req: Request): string {
    return (req.originalUrl ?? req.url ?? '').split('?')[0];
  }
}
