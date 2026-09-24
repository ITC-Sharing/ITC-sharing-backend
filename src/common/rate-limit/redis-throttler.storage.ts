import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { RedisService } from '../redis/redis.service';

/**
 * ThrottlerStorage backed by Redis, so every replica counts into one bucket.
 *
 * The guard depends on this interface and not on any implementation, so the
 * tiers, the keys and every test that drives them are untouched by the swap —
 * which was the point of depending on the interface in the first place.
 *
 * ── Why a Lua script ────────────────────────────────────────────────────
 * Counting is read-modify-write: increment, decide whether the limit is passed,
 * and block if it is. Split across round trips, two requests arriving together
 * both read the count before either writes, and a limit of 5 admits 6. Redis
 * runs a script to completion before serving anything else, which makes the
 * whole decision one indivisible step.
 *
 * ── Semantics, matching the in-memory store ─────────────────────────────
 * - A hit is NOT counted while blocked; the block is the answer.
 * - Passing the limit sets a block key for blockDuration.
 * - Both keys carry their own TTL, so expiry resets the window without a sweep.
 * - `timeToExpire` and `timeToBlockExpire` are SECONDS, as the guard expects.
 */

/**
 * KEYS: 1 hits, 2 block.  ARGV: 1 ttlMs, 2 limit, 3 blockDurationMs.
 * Returns { hits, ttlMs, isBlocked, blockTtlMs }.
 */
const INCREMENT = `
local blockTtl = redis.call('PTTL', KEYS[2])
if blockTtl > 0 then
  -- Blocked. Report the count as at least the limit: a caller being refused
  -- has no remaining budget, whatever the hits key happens to say after it
  -- has expired out from under a still-live block.
  local held = tonumber(redis.call('GET', KEYS[1]) or '0')
  local limit = tonumber(ARGV[2])
  if held < limit then held = limit end
  local ttl = redis.call('PTTL', KEYS[1])
  if ttl < 0 then ttl = 0 end
  return { held, ttl, 1, blockTtl }
end

local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
-- -1 is a key with no expiry, which only happens if INCR raced the TTL being
-- set. Either way the window has to be bounded or the counter is permanent.
if hits == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end

if hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  return { hits, ttl, 1, tonumber(ARGV[3]) }
end

return { hits, ttl, 0, 0 }
`;

/** Redis returns integers; this is the shape the script above produces. */
type IncrementReply = [number, number, number, number];

/**
 * Derived from the interface rather than imported: the record type is not
 * re-exported from the package index, and reaching into its dist path would
 * make a patch release able to break the build.
 */
type StorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

@Injectable()
export class RedisThrottlerStorage
  implements ThrottlerStorage, OnApplicationShutdown
{
  /**
   * The in-process store, kept as the fallback rather than discarded.
   *
   * When Redis cannot be reached the choice is between refusing every request,
   * allowing every request, and counting locally. The first is an outage of our
   * own making; the second hands an attacker a way to remove the limits by
   * taking out one dependency. Counting locally is the limit this service
   * enforced before Redis existed — degraded, bounded, and honest in the log.
   */
  private readonly local = new ThrottlerStorageService();

  constructor(private readonly redis: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<StorageRecord> {
    const client = this.redis.client;
    if (!client) {
      return this.local.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
      );
    }

    try {
      const reply = (await client.eval(
        INCREMENT,
        2,
        `throttle:${key}`,
        `throttle:${key}:blocked`,
        String(ttl),
        String(limit),
        String(blockDuration),
      )) as IncrementReply;

      this.redis.markHealthy();

      const [hits, ttlMs, blocked, blockTtlMs] = reply;
      return {
        totalHits: hits,
        timeToExpire: Math.ceil(ttlMs / 1000),
        isBlocked: blocked === 1,
        timeToBlockExpire: Math.ceil(blockTtlMs / 1000),
      };
    } catch (err) {
      this.redis.markUnhealthy(
        err instanceof Error ? err.message : 'unknown error',
      );
      return this.local.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
      );
    }
  }

  onApplicationShutdown(): void {
    // The fallback store holds one timer per counted request.
    this.local.onApplicationShutdown();
  }
}
