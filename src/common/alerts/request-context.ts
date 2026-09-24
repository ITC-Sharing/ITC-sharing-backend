import type { Request } from 'express';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';

/**
 * The part of a request a developer alert is allowed to carry.
 *
 * Deliberately two fields. Anything else on the request — headers, cookies,
 * body — is either a secret or a liability, and an alert that carried them
 * would put credentials in a chat log.
 */
export interface RequestCtx {
  ip: string;
  /** Raw User-Agent, trimmed. Never parsed into a device profile. */
  userAgent?: string;
}

/**
 * How much of an unrecognised agent is worth printing.
 *
 * A display limit ONLY. The agent is never shortened before parsing: the token
 * that names the browser sits at the END of a modern User-Agent —
 * "…AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" —
 * so trimming first removes the one part worth reading, and every Chrome
 * reports as an anonymous Mozilla string.
 */
const UA_MAX = 90;

/**
 * Pull the alertable context out of a request.
 *
 * The address comes from RateLimitGuard.resolveIp rather than `req.ip`, so the
 * alert says the same thing the rate limiter counted. That matters: the app
 * runs with `trust proxy` off, so `req.ip` and a forwarded header can be set by
 * the caller, and an alert naming a spoofed address is worse than one naming
 * none. When a proxy is put in front, both change in one place.
 */
export function contextFrom(req: Request): RequestCtx {
  const ua = req.headers?.['user-agent'];
  return {
    ip: RateLimitGuard.resolveIp(req),
    // Whole and untrimmed — see UA_MAX. Shortening happens at the point of
    // display, and only for an agent that nothing recognised.
    userAgent: typeof ua === 'string' && ua.trim() ? ua.trim() : undefined,
  };
}

/**
 * Browser and OS, read from the User-Agent.
 *
 * Deliberately a short list of regexes rather than a device-detection library:
 * the alert needs "which browser, which machine" to tell one session apart from
 * another, and a dependency that ships a database of thousands of devices would
 * be carrying weight this never uses. Anything unrecognised degrades to the raw
 * string rather than guessing.
 *
 * Order matters in both lists — Edge and Opera both claim to be Chrome, and
 * every Chrome claims to be Safari, so the most specific match has to win.
 */
/**
 * Non-browser clients, checked FIRST.
 *
 * Several of these impersonate a browser — Postman sends a Chrome-ish agent,
 * and a scraper will happily claim to be Safari — so asking "is this a browser"
 * before asking "is this a tool" gets the wrong answer. A request from curl is
 * a different event from a request from someone's laptop, and the alert should
 * say which.
 */
const CLIENTS: [RegExp, string][] = [
  [/\bPostmanRuntime\//i, 'Postman'],
  [/\bInsomnia\//i, 'Insomnia'],
  [/\bcurl\//i, 'curl'],
  [/\bWget\//i, 'Wget'],
  [/\bHTTPie\//i, 'HTTPie'],
  [/\bnode-fetch\b|\bundici\b|\baxios\//i, 'Node'],
  [/\bpython-requests\/|\bhttpx\//i, 'Python'],
  [/\bGo-http-client\//i, 'Go'],
  [/\bokhttp\//i, 'OkHttp'],
  [/\bPostmanRuntime|\bThunderClient\//i, 'Thunder Client'],
  [/\bbot\b|\bcrawler\b|\bspider\b|\bGooglebot\b/i, 'Bot'],
];

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\/[\d.]+/, 'Edge'],
  [/\bOPR\/[\d.]+|\bOpera\b/, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bFirefox\/[\d.]+|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/[\d.]+|\bCriOS\//, 'Chrome'],
  [/\bSafari\/[\d.]+/, 'Safari'],
];

const SYSTEMS: [RegExp, string][] = [
  [/\bWindows NT 10/, 'Windows'],
  [/\bWindows\b/, 'Windows'],
  [/\b(iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bLinux\b/, 'Linux'],
];

function match(ua: string, table: [RegExp, string][]): string | undefined {
  for (const [pattern, label] of table) {
    if (pattern.test(ua)) return label;
  }
  return undefined;
}

export interface ClientInfo {
  /** What made the request: "Chrome", "Safari", "Postman", "curl"… */
  browser: string;
  /** e.g. "macOS". Undefined when the agent names no platform. */
  os?: string;
}

/**
 * What made this request, and on what.
 *
 * Tools are matched before browsers on purpose — see CLIENTS. Anything that
 * matches neither is reported as the agent's own first token rather than a
 * guess: an unfamiliar client should read as unfamiliar, not be forced into
 * the nearest label.
 */
export function describeClient(userAgent?: string): ClientInfo | undefined {
  if (!userAgent) return undefined;

  const os = match(userAgent, SYSTEMS);
  const client = match(userAgent, CLIENTS);
  if (client) return { browser: client, os };

  const browser = match(userAgent, BROWSERS);
  if (browser) return { browser, os };

  /**
   * Neither a known tool nor a known browser.
   *
   * The leading token is NOT a useful answer here: virtually every agent on
   * the web opens with "Mozilla/5.0" for historical reasons, and reporting
   * that names nothing while looking like it named something. Same for the
   * engine tokens that follow it.
   *
   * So the whole agent is shown instead, truncated. It is uglier, and that is
   * the point — an alert that cannot identify the client should look like it
   * cannot, and hand over the string needed to work out what it was.
   */
  const lead = userAgent.split(/[\s/]/)[0];
  const useless = /^(Mozilla|AppleWebKit|Gecko|KHTML|Opera)$/i.test(lead);

  return {
    browser: useless ? userAgent.slice(0, UA_MAX) : lead.slice(0, 40),
    os,
  };
}
