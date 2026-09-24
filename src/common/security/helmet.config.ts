import helmet from 'helmet';
import type { RequestHandler } from 'express';

/**
 * Response security headers.
 *
 * Kept here rather than inline in `main.ts` for one reason: these are security
 * decisions, and a decision that can be unit-tested is one that cannot be
 * quietly loosened. `helmet.config.spec.ts` drives this through a real HTTP
 * round trip and asserts the exact header set.
 *
 * Every option below is written out even where it matches helmet's own
 * default. A default can change between major versions; a posture should not
 * change because a dependency was bumped.
 */
export function securityHeaders(): RequestHandler {
  return helmet({
    /**
     * This API answers with JSON and nothing else — no HTML, no Swagger UI, no
     * static assets, no template engine. So the policy can be the strictest
     * one there is: a response from here has no legitimate reason to load a
     * script, a style, a font or an image.
     *
     * Worth setting despite there being no HTML today. The cost is one header;
     * the alternative is depending on nobody ever adding an endpoint that
     * returns markup, and on whoever adds it remembering this file.
     */
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        // Clickjacking. Paired with X-Frame-Options below, which covers
        // clients predating CSP level 2.
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },

    /**
     * HSTS is only ever honoured over HTTPS — a browser ignores it on the
     * plain HTTP used in development — so it is set unconditionally rather
     * than gated on NODE_ENV, which keeps both environments on one code path.
     *
     * `preload` is off deliberately. Submitting a domain to the preload list
     * is effectively irreversible and binds every subdomain, present and
     * future. That is the institute's call, not a default to inherit.
     */
    strictTransportSecurity: {
      maxAge: 31_536_000, // one year
      includeSubDomains: true,
      preload: false,
    },

    /**
     * COOP is safe here because Google sign-in is a top-level redirect (see
     * GoogleSignInButton.vue), not a popup — nothing depends on
     * `window.opener`. The two `window.open` call sites in the client already
     * pass `noopener`.
     */
    crossOriginOpenerPolicy: { policy: 'same-origin' },

    /**
     * CORP does not interfere with the SPA: a cross-origin `fetch()` is
     * governed by the CORS check, while CORP governs no-cors subresource
     * loads — which is exactly the access worth denying. Note this protects
     * the API's own responses only; document bytes are served by MinIO, not by
     * this process.
     */
    crossOriginResourcePolicy: { policy: 'same-origin' },

    /**
     * COEP stays off. It buys cross-origin isolation, which a JSON API has no
     * use for, and it breaks every resource that has not opted in.
     */
    crossOriginEmbedderPolicy: false,

    /** Nothing here should leak a path to a third party in a Referer. */
    referrerPolicy: { policy: 'no-referrer' },

    /** DENY rather than helmet's SAMEORIGIN — it matches frame-ancestors. */
    xFrameOptions: { action: 'deny' },

    /**
     * The one that matters most next to the upload work: without it a browser
     * may ignore a declared Content-Type and sniff the bytes, which turns a
     * mislabelled response into whatever the content looks like.
     */
    xContentTypeOptions: true,

    /**
     * Explicitly 0. The legacy XSS auditor is removed from modern browsers and
     * its filter was itself exploitable; `1; mode=block` is worse than off.
     */
    xXssProtection: true,
  });
}
