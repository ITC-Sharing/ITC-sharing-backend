/**
 * Keeping secrets out of the log.
 *
 * Logs are the one place where data written for debugging outlives the request
 * that produced it. They get copied into tickets, pasted into chat, shipped to
 * whatever aggregates them, and read by people who were never authorised to see
 * a password. So the rule here is not "avoid logging secrets" — that is a habit,
 * and habits lapse — but "the logger cannot emit one", enforced at the two
 * places every request passes through.
 *
 * Two independent passes, because neither alone is enough:
 *
 *   By KEY   — a field called `password` is a secret whatever it holds. This
 *              catches structured data: query strings, objects, `k=v` pairs
 *              inside otherwise free text.
 *   By SHAPE — a JWT is a secret whatever it is called. This catches the
 *              unstructured half: a token pasted into an error message, a card
 *              number in a stack trace, a bearer header echoed by a library
 *              that never heard of our key list.
 */

export const REDACTED = '[redacted]';

/**
 * Field names whose value is never logged.
 *
 * Deliberately NOT matching a bare `id`: `major_id` and `uploader_id` are
 * ordinary foreign keys and redacting them would cost the log most of its
 * value. Identity documents are matched by their specific names instead.
 */
const SENSITIVE_KEY =
  // Every inner group is non-capturing. KEYED_IN_TEXT embeds this source and
  // then reads its own groups by index, so a capturing group in here would
  // silently renumber them — which produced `otpundefined[redacted]` before.
  /(pass(?:word|wd)?|pwd|secret|token|otp|credential|signature|cookie|session|auth|bearer|api[-_]?key|private[-_]?key|card(?:number)?|cvv|cvc|ssn|national[-_]?id|id[-_]?(?:card|number)|passport|address)/i;

/**
 * Query parameters whose value may be logged, as an allowlist.
 *
 * A closed set, so a parameter added later is redacted until someone decides
 * otherwise — the safe direction to fail in. `search` is absent on purpose: it
 * is free text a person typed, and people type addresses and ID numbers into
 * search boxes.
 */
const SAFE_QUERY_KEYS = new Set([
  'page',
  'limit',
  'offset',
  'sort',
  'order',
  'filter',
  'status',
  'since',
  'lang',
  'doc_type',
  'year_level',
  'semester',
  'major_id',
  'subject_id',
  'upload_id',
  'uploader_id',
]);

/** `header.payload.signature` — unmistakable, and always a credential. */
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;

/** `Authorization: Bearer …`, wherever a library happened to echo it. */
const BEARER = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

/** `password=…`, `token: …` — a sensitive key and its value inside free text. */
const KEYED_IN_TEXT = new RegExp(
  // Both affixes are `*`, not `+`. An earlier version opened with
  // `[A-Za-z_][A-Za-z0-9_-]*`, which forced at least one character BEFORE the
  // sensitive word — so `refresh_token=` matched and a bare `password=` did
  // not. The names most worth catching are the ones with no prefix at all.
  `\\b([A-Za-z0-9_-]*(?:${SENSITIVE_KEY.source.slice(1, -1)})[A-Za-z0-9_-]*)` +
    `(\\s*[=:]\\s*)` +
    // The scheme is part of the value, not a separate word. Without this,
    // `Authorization: Bearer sk_live_…` matched with `Bearer` as the value —
    // redacting the scheme and publishing the credential after it.
    `(?:(?:Bearer|Basic|Token|Digest)\\s+)?(?:"[^"]*"|'[^']*'|[^\\s,;)&}]+)`,
  'gi',
);

/** A run long enough to be a key or signature rather than an identifier. */
const LONG_OPAQUE = /\b[A-Za-z0-9_-]{40,}\b/g;

/** 13–19 digits, optionally spaced or dashed. Confirmed with Luhn below. */
const CARD_SHAPED = /\b(?:\d[ -]?){12,18}\d\b/g;

/**
 * Whether a digit run is a plausible card number.
 *
 * Without this, every long number is a card: a timestamp, a byte count, an
 * order reference. Luhn is what separates "looks like digits" from "is a
 * payment instrument", and it costs one pass.
 */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Scrub free text — an exception message, a stack, anything unstructured.
 *
 * Order matters: the keyed pass runs first so `token=eyJ…` is replaced whole
 * rather than leaving a bare `token=` next to a separately redacted value.
 */
export function redactText(input: string): string;
export function redactText(input: string | undefined): string | undefined;
export function redactText(input: string | null): string | null;
export function redactText(
  input: string | undefined | null,
): string | undefined | null {
  // Passing through undefined rather than coercing to '' keeps `stack` absent
  // when it was absent — ConsoleLogger renders those two differently.
  if (!input) return input;

  return input
    .replace(
      KEYED_IN_TEXT,
      (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`,
    )
    .replace(JWT, REDACTED)
    .replace(BEARER, (_m, prefix: string) => `${prefix}${REDACTED}`)
    .replace(CARD_SHAPED, (m) =>
      passesLuhn(m.replace(/[ -]/g, '')) ? REDACTED : m,
    )
    .replace(LONG_OPAQUE, REDACTED);
}

/**
 * A URL safe to log: the path, and only the query values that were allowlisted.
 *
 * The parameter NAMES are kept even when their value is dropped, because
 * "this request carried a code" is useful and the code itself is not. The
 * Google callback is the live case — `?code=…` is an authorization code, and a
 * log holding one is a log holding a way into somebody's account.
 */
export function safeUrl(url: string | undefined | null): string {
  if (!url) return '';

  const split = url.indexOf('?');
  if (split === -1) return url;

  const path = url.slice(0, split);
  const query = new URLSearchParams(url.slice(split + 1));

  const parts: string[] = [];
  for (const key of new Set(query.keys())) {
    const safe = SAFE_QUERY_KEYS.has(key.toLowerCase());
    for (const value of query.getAll(key)) {
      parts.push(`${key}=${safe ? redactText(value) : REDACTED}`);
    }
  }

  return parts.length ? `${path}?${parts.join('&')}` : path;
}

/**
 * Deep-copy a value with every sensitive field replaced.
 *
 * Returns a new structure rather than mutating: the caller is logging something
 * the application is still using, and a redactor that emptied the real object
 * would be a far worse bug than the one it set out to prevent.
 */
export function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactObject(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactObject(v, depth + 1);
  }
  return out;
}
