# Rate limiting

Every request is counted by a single global guard, `RateLimitGuard`. Routes name
a *tier*; the tier says how many requests, over how long, keyed by whom.

## Where the numbers live

`src/common/rate-limit/rate-limit.config.ts` — all of them, in one table. To
change a limit, edit that file and nothing else. Controllers never carry
numbers.

| Tier | Limit | Keyed by |
|---|---|---|
| `global` | 300 / minute | IP |
| `auth` | 5 / 15 min **and** 20 / 15 min | IP + email, and IP |
| `signup` | 3 / hour | IP |
| `refresh` | 60 / hour | user (from the refresh cookie) |
| `email-send` | 5 / 15 min **and** 3 / hour | IP, and IP + email |
| `email-code` | 10 / 15 min **and** 30 / 15 min | IP + email, and IP |
| `oauth` | 20 / 15 min | IP |
| `write` | 60 / minute | user |
| `upload` | 60 / 10 min | user |
| `search` | 60 / minute | user |
| `book-request` | 10 / hour | user |
| `telegram-link` | 5 / 10 min | user |
| `telegram-webhook` | 120 / minute | IP |

`auth` is the only tier with two counters. One attacker grinding a single
account and one spraying many accounts from one address look nothing alike, and
a single counter cannot catch both. Either counter tripping returns 429.

## Which tier a route gets

Nothing, usually. A route with no decorator is placed by its method:

- `POST` / `PATCH` / `PUT` / `DELETE` → `write`
- everything else → `global`

Only routes that genuinely differ carry `@RateLimitTier('…')`. There are 19 of
them out of 86.

```ts
@RateLimitTier('upload')
@Post('staged-files')
stage(...) { … }
```

A tier replaces the default; it does not stack with it.

## How the caller is identified

**Authenticated routes** key on the user id, so two students behind one campus
NAT do not share a budget.

The guard reads that id from the access token itself, not from `req.user`. A
global guard runs *before* the route's `JwtAuthGuard`, so `req.user` is still
empty — reading it would silently key every per-user limit by address instead.
The signature is verified, not just decoded: an unverified `sub` is
attacker-chosen, and would let one caller spend someone else's budget or mint a
fresh identity per request. A token that fails verification is not an error
here; the request is simply counted by address, and the route's real auth guard
answers it.

**`/auth/refresh`** keys on the `sub` inside the refresh cookie. It is the one
per-user route reached with no Authorization header — the access token it exists
to replace is expired, or, since the token is held in memory, was never there on
a cold page load. Keyed as an ordinary `user` route it would fall back to the
address and put a whole lecture hall on one 60/hour counter. The cookie is
verified against `JWT_REFRESH_SECRET` for the same reason the access token is,
and the cookie *value* is deliberately not the key: it rotates on every use, so
it would start a fresh counter each call and limit nothing.

**Unauthenticated routes** key on `req.socket.remoteAddress`.

**Auth routes** additionally key on the account being addressed. The email is
normalised (trimmed, lower-cased) and then SHA-256'd, so no readable address
ever enters a counter key or a log line.

## Why the socket IP, and not `X-Forwarded-For`

The API is currently exposed directly — there is no nginx or Caddy in
`docker-compose.prod.yml`. That means `X-Forwarded-For` is written by whoever is
calling. Trust it and an attacker sends a fresh value per request; no limit ever
trips.

Express's `trust proxy` is therefore **off** (its default, asserted in
`main.ts`), and the guard reads `req.socket.remoteAddress` directly rather than
`req.ip`, so the behaviour does not change meaning if someone flips that setting
later.

### When a reverse proxy is added

The failure inverts, and it is worse: every request arrives from the proxy's
address, so all users share one counter and the first busy minute locks out the
whole campus. In the same commit that introduces the proxy:

1. Set `trust proxy` to the **exact hop count** (e.g. `app.set('trust proxy', 1)`).
   Never `true` — that trusts the whole chain and restores the spoofing problem.
2. Change `RateLimitGuard.resolveIp` to use the proxy-derived address.
3. Add a test asserting two different client IPs still receive two counters.

## Storage

**Redis when `REDIS_URL` is set; this process's memory when it is not.**

Both subsystems that count — the tiers here and the upload byte quota — share
one connection and the same rule. Set the variable and every replica spends from
one bucket. Leave it unset and each process counts alone, which is correct for
the single container that runs today and wrong the moment a second one starts:
each replica enforces every limit independently, so 5-per-15-minutes becomes
5 × N. `docker-compose.yml` and `docker-compose.prod.yml` both run a `redis`
service, so the path that runs in production is the path that gets exercised in
development.

Redis is configured with no persistence (`--save "" --appendonly no`). Every key
here is a counter carrying its own TTL; losing them on restart costs one window,
and the alternative is fsync'ing values that expire in sixty seconds.

### Why a Lua script

Counting is read-modify-write: increment, decide whether the limit is passed,
block if it is. Split across round trips, two requests arriving together both
read the count before either writes, and a limit of 5 admits 6. Redis runs a
script to completion before serving anything else, which makes the whole
decision one indivisible step. The byte quota uses the same approach for the
same reason — `upload-quota.redis.spec.ts` fires six simultaneous 2 MB uploads
at a 10 MB budget and asserts that exactly five are admitted.

### What happens when Redis is down

Counters fall back to this process. Not to no limit, and not to refusing every
request: the fallback is the limit this service enforced before Redis existed —
degraded, still bounded, and loud in the log. `RedisService` logs the transition
once at ERROR on the way down and once at LOG on the way back up, rather than
one line per request.

A known-bad socket is skipped rather than waited on. ioredis holds a command in
its offline queue until the next reconnect attempt resolves, and the reconnect
backoff grows toward five seconds — so without the status check in
`RedisService.client`, every request during an outage would stall behind it.
Measured: ~1s per request with the queue, 0ms with the check. `connecting` is
deliberately not treated as bad, because that is the few milliseconds at boot
before the socket opens, and queueing through it is what makes the first
requests count correctly.

### `ThrottlerModule` is not imported

Only the `ThrottlerStorage` *interface* is borrowed from `@nestjs/throttler`.
The module used to be imported for its default storage provider, and that did
not survive supplying our own: `ThrottlerModule` is `@Global()`, so its provider
for the token shadowed the one declared in `rate-limit.module.ts`. Every request
kept counting into the in-memory store while the Redis implementation sat
unused — nothing failed, nothing logged, and the limits still worked, on the
wrong store. `rate-limit.wiring.spec.ts` exists to assert which implementation
the token actually resolves to.

## The 429

```
HTTP/1.1 429 Too Many Requests
Retry-After: 3600
RateLimit-Limit: 3
RateLimit-Remaining: 0
RateLimit-Reset: 3600
```

```json
{ "success": false, "message": "Too many requests. Please try again later.", "statusCode": 429 }
```

The body names neither the rule that tripped, the limit, nor the caller — an
attacker would rather know all three. `RateLimit-*` headers are set on *every*
response, describing whichever counter is closest to its limit.

## Logging

One `WARN` per rejection, on the `RateLimit` context:

```
rate limit exceeded tier=signup rule=signup key=ip POST /auth/register retry_after=3600s
```

Metadata only. No key, no user id, no address, no email, no header, no body. The
kind of counter (`user` / `ip` / `ip-email`) is enough to tell which rule is
misconfigured.

## TODO

**Upload byte quota.** The planned 500 MB/hour/user is *not* implemented. The
`upload` tier bounds how often an upload arrives, never how large one is, and
uploads still use multer `memoryStorage()` — 10 files × 20 MB means one accepted
request can hold 200 MB of RAM. Counting bytes needs somewhere durable to
accumulate them per user per hour, which is a subsystem rather than a limit, and
building it on the in-memory store would lose the count on every deploy. The
real fix for the memory exposure is streaming uploads to S3; that is independent
of rate limiting and should not be mistaken for it.

**Both subsystems, one dependency.** Redis is now on the request path for every
route (the tiers) and every upload (the byte quota). It degrades rather than
fails, but it is a new thing that can be down, and the degraded mode is only
correct while one replica runs — two replicas with Redis unreachable are back to
multiplying every limit.

**`pending_registrations` is dead.** The table and its entity survive from an
abandoned OTP draft, keyed on a `student_id` column that has since been dropped
from `users`. Email verification was built as a link instead — see
`auth.service.ts` — so there is no code to guess and `attempts` protects
nothing. The table is safe to drop; nothing reads it.

**Emailed codes are rationed twice over.** Both flows — confirming an address
and resetting a password — now send a six-digit code rather than a link. A six-digit code has a million
possibilities, which is minutes of scripted guessing — so the defence is not the
size of the secret but the number of guesses allowed against it. Five wrong
answers burn the code in the database (`email_tokens.attempts`), and getting a
fresh one costs a `email-send` slot, of which there are three an hour per
address. The `email-code` tier sits on top to stop one address being worked on
from many angles at once, and one machine from working through many addresses.

**Sending mail is limited twice.** `email-send` bounds both the address being
targeted (3/hour) and the machine doing the asking (5/15min). The cost of a
loose limit here is not CPU — it is somebody else's inbox, and our sending
domain being the one reported for it. Redeeming a link is looser (`email-link`),
because the token is 32 bytes of CSPRNG and cannot be searched for.
