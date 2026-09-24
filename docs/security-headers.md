# Security headers

Every response carries a fixed set of headers, applied by `helmet` as the first
middleware in the chain — before CORS, before cookies, before any guard — so
they are present on preflights and on responses a guard rejects, not just on
successful ones.

## Where the decisions live

`src/common/security/helmet.config.ts`, as one exported function. Not inline in
`main.ts`, for one reason: a decision that can be unit-tested is one that cannot
be quietly loosened. `helmet.config.spec.ts` drives the middleware through a
real HTTP round trip and asserts the exact header set, so relaxing the CSP means
changing a test that says why it was tight.

Every option is written out even where it matches helmet's own default. A
default can change when a dependency is bumped; a security posture should not.

## What is sent

| Header                         | Value                                                                             | Why                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`      | `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` | This API returns JSON and nothing else — no HTML, no Swagger UI, no static assets — so it has no legitimate reason to load a script, style, font or image |
| `X-Frame-Options`              | `DENY`                                                                            | Clickjacking, for clients predating CSP level 2. `DENY` rather than helmet's `SAMEORIGIN`, to match `frame-ancestors`                                     |
| `X-Content-Type-Options`       | `nosniff`                                                                         | Without it a browser may ignore a declared Content-Type and sniff the bytes                                                                               |
| `Strict-Transport-Security`    | `max-age=31536000; includeSubDomains`                                             | One year. Honoured only over HTTPS, so it is set unconditionally rather than gated on `NODE_ENV`                                                          |
| `Referrer-Policy`              | `no-referrer`                                                                     | No path from here should reach a third party in a `Referer`                                                                                               |
| `Cross-Origin-Opener-Policy`   | `same-origin`                                                                     | Safe here: Google sign-in is a top-level redirect, not a popup                                                                                            |
| `Cross-Origin-Resource-Policy` | `same-origin`                                                                     | Denies no-cors subresource loads. Does not affect the SPA, whose `fetch()` is governed by CORS                                                            |
| `X-XSS-Protection`             | `0`                                                                               | The legacy auditor was itself exploitable; `1; mode=block` is worse than off                                                                              |
| `X-Powered-By`                 | _removed_                                                                         | Stops advertising the framework and its version                                                                                                           |

`Cross-Origin-Embedder-Policy` is deliberately **not** sent. It buys cross-origin
isolation, which a JSON API has no use for, and it breaks every resource that
has not opted in.

`preload` is deliberately **not** in the HSTS value. Submitting a domain to the
preload list is close to irreversible and binds every subdomain, present and
future — the institute's decision to make, not a default to inherit.

## What these headers do not cover

Document bytes are served by **MinIO**, not by this process, so none of the
above applies to a file download. What protects those is a different mechanism:
a private bucket, a presigned URL minted only after authorisation, and a forced
`Content-Disposition: attachment`. See `docs/file-upload.md`.

## Before putting a proxy in front

`app.set('trust proxy', false)` in `main.ts` is load-bearing for the rate
limiter, not for these headers — but if nginx or Caddy is added, check it does
not strip or duplicate any header above. See `docs/rate-limiting.md`.
