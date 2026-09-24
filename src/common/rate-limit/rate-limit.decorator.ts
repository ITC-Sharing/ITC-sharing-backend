import { SetMetadata } from '@nestjs/common';
import type { RateLimitTierName } from './rate-limit.config';

export const RATE_LIMIT_TIER = 'rate_limit_tier';

/**
 * Puts a route in a rate-limit tier other than the one its method implies.
 *
 *   @RateLimitTier('auth')
 *   @Post('login')
 *   login() { … }
 *
 * Works on a route or a whole controller; the route wins. Leave it off unless
 * the route genuinely differs — writes already default to `write` and reads to
 * `global`, so most routes need nothing.
 *
 * The limits themselves live in rate-limit.config.ts.
 */
export const RateLimitTier = (tier: RateLimitTierName) =>
  SetMetadata(RATE_LIMIT_TIER, tier);
