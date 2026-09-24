/**
 * Every rate limit in the API, in one place.
 *
 * Deliberately a table rather than numbers scattered through decorators: a limit
 * is a product decision that gets tuned against real traffic, and tuning it
 * should mean editing one line here, not hunting through controllers. Routes
 * name a tier; only this file says what a tier costs.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * How a caller is identified for one counter.
 *
 * - `user`    the authenticated user id, falling back to the IP when there is
 *             no session — an unauthenticated write still has to be bounded.
 * - `ip`      the socket address. Never a forwarded header: see resolveIp.
 * - `ip-email`the IP paired with the account being addressed, so one account
 *             cannot be ground down from many angles.
 * - `refresh-user`
 *             the account named by the refresh cookie. For the one route that
 *             is per-user but carries no access token to read it from: `user`
 *             would quietly degrade to `ip` there, and behind a campus NAT that
 *             is one shared budget for everybody.
 */
export type RateLimitKeyKind = 'user' | 'ip' | 'ip-email' | 'refresh-user';

export interface RateLimitRule {
  /** Namespace for the counter, and what appears in the rejection log. */
  readonly name: string;
  readonly limit: number;
  /** Window length in milliseconds. */
  readonly ttlMs: number;
  readonly key: RateLimitKeyKind;
}

export type RateLimitTierName = keyof typeof RATE_LIMIT_TIERS;

/**
 * A tier is a list of counters, all of which must pass. Only `auth` needs more
 * than one: an attacker working a single account and an attacker spraying many
 * accounts from one address look nothing alike, and a single counter cannot
 * catch both.
 */
export const RATE_LIMIT_TIERS = {
  /** The default every route inherits. A person browsing hard stays well under. */
  global: [{ name: 'global', limit: 300, ttlMs: 1 * MINUTE, key: 'ip' }],

  /**
   * Sign-in. Tight because every attempt costs a bcrypt hash — cheap to send,
   * expensive to answer — and because five honest failures in a quarter of an
   * hour is already unusual.
   */
  auth: [
    { name: 'auth-account', limit: 5, ttlMs: 15 * MINUTE, key: 'ip-email' },
    { name: 'auth-ip', limit: 20, ttlMs: 15 * MINUTE, key: 'ip' },
  ],

  /** Account creation: writes a row and runs a hash. */
  signup: [{ name: 'signup', limit: 3, ttlMs: 1 * HOUR, key: 'ip' }],

  /**
   * A 15-minute access token refreshes about four times an hour on its own, and
   * once more per cold page load — the access token is held in memory, so every
   * reload re-mints it from this cookie. Several tabs and a lot of reloading
   * fit inside 60; a retry loop does not.
   *
   * Keyed from the cookie rather than `user`: this route is reached without an
   * Authorization header, so `user` would fall back to the address and put a
   * whole lecture hall on one counter.
   */
  refresh: [
    { name: 'refresh', limit: 60, ttlMs: 1 * HOUR, key: 'refresh-user' },
  ],

  /**
   * Asking us to send mail: resend-verification and forgot-password.
   *
   * Tight, and keyed by IP because there is no session — these are reached by
   * people who cannot sign in. The cost of a loose limit is not CPU: it is
   * somebody else's inbox filling up, and our sending domain being the one that
   * gets reported for it.
   */
  'email-send': [
    { name: 'email-send-ip', limit: 5, ttlMs: 15 * MINUTE, key: 'ip' },
    { name: 'email-send-addr', limit: 3, ttlMs: 1 * HOUR, key: 'ip-email' },
  ],

  /**
   * Submitting an emailed six-digit code — confirming an address, or finishing
   * a password reset. Both are the same shape of secret and need the same
   * budget.
   *
   * The per-code cap of five wrong guesses is the real control; this stops one
   * address being worked on from many angles at once, and stops one machine
   * working through many addresses.
   */
  'email-code': [
    { name: 'email-code-addr', limit: 10, ttlMs: 15 * MINUTE, key: 'ip-email' },
    { name: 'email-code-ip', limit: 30, ttlMs: 15 * MINUTE, key: 'ip' },
  ],

  /** Starting Google sign-in writes a state cookie. The consent screen is its own friction. */
  oauth: [{ name: 'oauth', limit: 20, ttlMs: 15 * MINUTE, key: 'ip' }],

  /** Ordinary creates, edits and deletes — above human speed, below a loop. */
  write: [{ name: 'write', limit: 60, ttlMs: 1 * MINUTE, key: 'user' }],

  /**
   * Uploads. Staged files are sent one per file picked, so a ten-file upload is
   * ten calls and the window has to be generous. NOTE: this bounds how OFTEN an
   * upload arrives, never how large one is — see the byte-quota TODO in
   * docs/rate-limiting.md.
   */
  upload: [{ name: 'upload', limit: 60, ttlMs: 10 * MINUTE, key: 'user' }],

  /** Every ILIKE path. Unindexed substring scans are the cheapest way to make the database the bottleneck. */
  search: [{ name: 'search', limit: 60, ttlMs: 1 * MINUTE, key: 'user' }],

  /** As much courtesy as security: each one notifies a real person. */
  'book-request': [
    { name: 'book-request', limit: 10, ttlMs: 1 * HOUR, key: 'user' },
  ],

  /** Each call writes a row and invalidates the previous token. */
  'telegram-link': [
    { name: 'telegram-link', limit: 5, ttlMs: 10 * MINUTE, key: 'user' },
  ],

  /** Comfortably above Telegram's real delivery rate; there is no session to key on. */
  'telegram-webhook': [
    { name: 'telegram-webhook', limit: 120, ttlMs: 1 * MINUTE, key: 'ip' },
  ],
} as const satisfies Record<string, readonly RateLimitRule[]>;

/**
 * What an unlabelled route gets.
 *
 * Writes are bounded more tightly than reads without anyone decorating them,
 * which keeps the decorator for the cases that genuinely differ — the
 * alternative is 86 decorators, most of them saying the obvious.
 */
export function defaultTierForMethod(method: string): RateLimitTierName {
  return method === 'POST' ||
    method === 'PATCH' ||
    method === 'PUT' ||
    method === 'DELETE'
    ? 'write'
    : 'global';
}

/** Body returned on rejection. Says when to retry, never which rule tripped. */
export const RATE_LIMIT_MESSAGE = 'Too many requests. Please try again later.';
