# Developer alerts (Telegram)

A one-way channel from the API to **one chat: yours**. It is an observability
tool, not a feature — no student ever sees it, nothing is stored, and no table
was added for it.

## Not the same bot as the student one

`src/modules/telegram/` already runs a bot that students connect to their
accounts, with link tokens and a `telegram_link_tokens` table. This is a
**second bot** with its own token.

They are kept apart deliberately: one revoked token or one rate-limited bot must
not take out the other, and a bug in the student path must not be able to
address the developer chat. The only thing they share is the Bot API itself.

## Setting it up

1. Message [@BotFather](https://t.me/BotFather) → `/newbot`, answer the two
   prompts, and copy the token it gives you into `TELEGRAM_ALERT_BOT_TOKEN`.
2. Open a chat with your new bot and send it anything — a bot cannot message
   someone who has never messaged it.
3. Get your chat id: visit
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read
   `result[0].message.chat.id`. That is `TELEGRAM_DEVELOPER_CHAT_ID`.
4. Restart the API. If the channel is live the first alert arrives the next time
   anyone logs in.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `TELEGRAM_ALERT_BOT_TOKEN` | — | The alert bot's token. Empty means the channel is off. |
| `TELEGRAM_DEVELOPER_CHAT_ID` | — | The one chat alerts go to. Empty means off. |
| `TELEGRAM_ALERTS_ENABLED` | `true` | `false` switches everything off while leaving the credentials in place. |
| `TELEGRAM_ALERTS_INCLUDE_CODES` | `false` | Puts the real 6-digit code in the alert. **Ignored when `APP_ENV=production`.** |
| `APP_ENV` | `development` | Printed on every alert, and the guard above. |

All five live in `.env`, which is git-ignored (line 39). None of them is read by,
sent to, or reachable from the Vue app.

## Forum topics

If the chat is a **supergroup with topics turned on**, each kind of alert can go
to its own thread instead of one flat stream. Four groups, because these are the
questions asked separately — who got in, who signed up, what the auth system is
worried about, and what broke:

| Variable | Receives |
|---|---|
| `TELEGRAM_TOPIC_LOGIN` | Login Successful, Login Failed |
| `TELEGRAM_TOPIC_REGISTRATION` | New Registration |
| `TELEGRAM_TOPIC_OTP` | Code Sent, Code Burned, Password Reset — the whole emailed-code flow, since a reset is completed with a code in this system |
| `TELEGRAM_TOPIC_SERVER_ERRORS` | Server errors, the throttle notice, and Refresh Token Reuse |

Leave one empty and that group posts to the group's **General** topic. Leave all
four empty and nothing changes — `message_thread_id` is omitted entirely, which
matters because sending it to a chat that is not a forum is an error rather than
something Telegram ignores.

**Finding a thread id:** post any message in the topic, open
`https://api.telegram.org/bot<TOKEN>/getUpdates`, and read `message_thread_id`
from the result. The `chat.id` in the same payload is your
`TELEGRAM_DEVELOPER_CHAT_ID` — for a supergroup it is negative, and the minus
sign is part of it.

A value that is not a positive integer is ignored and that group falls back to
General. A typo would otherwise make Telegram refuse every message in that
group, and a visible fallback beats silence.

## What generates an alert

Chosen from the events this system actually has, not from what is possible.

| Alert | Raised at | Why it is worth a message |
|---|---|---|
| Login Successful | `AuthService.login()` **and** `completeGoogleLogin()` | Who got in, and from where. `LOGIN` carries the address for a password sign-in and `Google OAuth` for the OAuth path, because nothing is typed there |
| Login Failed | all four password refusals, plus four Google ones — a rejected code exchange, an id_token that will not verify, an unverified Google address, and a banned account | The reason is the *internal* one — unknown account, wrong password, unverified, banned — which the caller never receives |
| New Registration | `AuthService.register()` | Registration is open; this is the only signal that someone used it |
| Code Sent | `issueEmailToken()` | Covers verification and reset, both purposes |
| Code Burned | `redeemCode()` attempt cap | Five wrong guesses at one code — somebody is trying |
| Password Reset | `resetPassword()` success | Includes how many sessions it revoked |
| Refresh Token Reuse | `assertWithinReuseGrace()` | The strongest signal the auth system produces: a token used twice |
| Server Error | `AllExceptionsFilter`, **5xx only** | Something broke that was not the client's fault |

**4xx never alerts.** A rejected password, a refused upload, a rate limit — that
is a validated, authorising system working. Forwarding those would make the
channel a worse copy of the log.

## What is deliberately never sent

Passwords, password hashes, JWTs, refresh tokens, reset tokens, `Authorization`
headers, cookies, request bodies, stack traces, database credentials, S3 keys,
and the bot token itself.

Stack traces are excluded specifically: one can hold a connection string. The
server log keeps them — that is what it is for.

**Verification codes** are the one conditional case. They are withheld in
production regardless of configuration; `TELEGRAM_ALERTS_INCLUDE_CODES=true`
only has an effect when `APP_ENV` is not `production`, which makes local testing
bearable without creating a way to leak live codes.

Email addresses, IPs and clients *are* included — they are the fields that make
an alert actionable.

`BROWSER` names what made the request: a browser (Chrome, Safari, Firefox, Edge,
Opera, Samsung Internet) or a tool (Postman, curl, Wget, HTTPie, Insomnia, Node,
Python, Go, OkHttp) — tools are matched **first**, because several of them send a
Chrome-shaped User-Agent and would otherwise be reported as Chrome. An agent
matching neither is reported by its own leading token rather than forced into the
nearest label. `OS` carries the platform separately.

## Where the IP comes from

`RateLimitGuard.resolveIp()` — the same function the rate limiter counts by, so
an alert names the address the limiter saw. It reads `req.socket.remoteAddress`
and deliberately ignores `X-Forwarded-For`, because the app runs with
`trust proxy` off and a forwarded header is written by whoever is calling. When
a reverse proxy is added, both change in one place. See `docs/rate-limiting.md`.

## When Telegram is down

Nothing happens to the request. Every method returns `void`, delivery is never
awaited by a request path, and failures are caught and logged at WARN through
the ordinary Nest logger:

```
[DevAlertService] Telegram alert failed: ENOTFOUND api.telegram.org
```

A login succeeds whether or not the alert arrives. This is an alerting channel,
not a dependency of authentication.

## Flood control

Two limits, both inside `DevAlertService` — the existing rate limiter is for
inbound HTTP and is not involved.

- **Deduplication**: identical alerts collapse for 60 seconds. One broken
  endpoint hit fifty times is one message, and the next one carries
  *"+49 identical suppressed in the last minute"*.
- **Ceiling**: 20 alerts a minute across every kind. Past that a single
  *"Alerts throttled"* notice is sent and the rest are dropped until the window
  turns over.

## Testing

`src/common/alerts/dev-alert.service.spec.ts` — 24 tests with `fetch` mocked, so
a test run can never deliver a real message. They cover enabled and disabled,
missing configuration, a refused API call, a failed network, every alert type,
the production code guard, HTML escaping of user-controlled text, and both flood
controls.

To try it by hand, set the three variables, start the API, and:

```sh
# login failed
curl -X POST localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"nobody@itc.edu.kh","password":"wrong-password"}'

# server error — any 5xx path
```
