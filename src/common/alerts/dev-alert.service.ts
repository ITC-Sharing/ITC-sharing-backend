import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describeClient, type RequestCtx } from './request-context';

/**
 * Developer alerts, delivered to one Telegram chat.
 *
 * ── Why this is not the existing TelegramService ─────────────────────────
 * That one talks to students: it links accounts, resolves a chat id from a
 * user row, and forgets a chat that blocks the bot. This one talks to exactly
 * one hard-configured chat and knows nothing about users. Sharing a bot token
 * between the two would mean an outage or a revoked token takes both down, and
 * a bug in the student path could address the developer chat. They are kept
 * apart on purpose.
 *
 * ── Never a dependency ───────────────────────────────────────────────────
 * Every method returns void and swallows everything. A login must not fail
 * because Telegram is unreachable, so nothing here is awaited by a request
 * path — delivery is fire-and-forget and failures land in the ordinary logger.
 */

/** What an alert is about. Also the throttle bucket. */
export type AlertKind =
  | 'login.ok'
  | 'login.failed'
  | 'register'
  | 'code.issued'
  | 'code.burned'
  | 'password.reset'
  | 'refresh.reuse'
  | 'server.error';

/**
 * What a login alert says about who, and how.
 *
 * An object rather than a sixth positional argument: the two ways into this
 * system describe themselves differently — a password login has an address
 * that was typed, a Google login has no typed identifier at all — and that
 * difference belongs in a named field rather than an argument position.
 */
export interface LoginAlert {
  /** The LOGIN line: the address typed, or how they came in. */
  login: string;
  userId?: string;
  name?: string;
}

interface Alert {
  kind: AlertKind;
  /** One line, no field labels — the subject of the message. */
  title: string;
  /** Ordered label/value pairs. Undefined values are dropped, not printed. */
  fields: Record<string, string | number | undefined>;
  /** Groups repeats: identical signatures inside the window are coalesced. */
  signature?: string;
}

/**
 * Which topic each kind belongs in, when the chat is a forum.
 *
 * Grouped rather than one topic per kind: eight topics would be eight places
 * to look, and these four are the questions actually asked separately — who
 * got in, who signed up, what the auth system is worried about, and what
 * broke.
 */
const TOPIC_OF: Record<AlertKind, TopicGroup> = {
  'login.ok': 'login',
  'login.failed': 'login',
  register: 'registration',

  // The emailed-code flow, end to end. A password reset belongs here because
  // in this system it IS completed with a code — same table, same bcrypt, same
  // five-guess cap as a verification.
  'code.issued': 'otp',
  'code.burned': 'otp',
  'password.reset': 'otp',

  // Reuse is not a server error, and it is not an OTP event either. It sits
  // here because this is the "something is wrong, look now" topic, and a token
  // used twice is the most serious thing this system can tell you. Give it
  // TELEGRAM_TOPIC_SECURITY to move it somewhere of its own.
  'refresh.reuse': 'errors',
  'server.error': 'errors',
};

type TopicGroup = 'login' | 'registration' | 'otp' | 'errors';

/** Env var per group. Unset means "post to the group's General topic". */
const TOPIC_ENV: Record<TopicGroup, string> = {
  login: 'TELEGRAM_TOPIC_LOGIN',
  registration: 'TELEGRAM_TOPIC_REGISTRATION',
  otp: 'TELEGRAM_TOPIC_OTP',
  errors: 'TELEGRAM_TOPIC_SERVER_ERRORS',
};

/** Repeats of one signature inside this window are folded into a count. */
const DEDUPE_MS = 60_000;
/** Ceiling across every kind, so a failure storm cannot flood the chat. */
const GLOBAL_PER_MIN = 20;

@Injectable()
export class DevAlertService {
  private readonly logger = new Logger(DevAlertService.name);

  private readonly token: string | null;
  private readonly chatId: string | null;
  private readonly enabled: boolean;
  private readonly env: string;
  private readonly systemName: string;
  private readonly timeZone: string;
  /** Resolved thread ids, or undefined for a group with no topic configured. */
  private readonly topics: Partial<Record<TopicGroup, number>> = {};
  private readonly includeSecretsInDev: boolean;

  /** signature -> when it was last sent, and how many were suppressed since. */
  private readonly recent = new Map<string, { at: number; held: number }>();
  private windowStartedAt = Date.now();
  private sentThisWindow = 0;
  private floodNoticeSent = false;

  constructor(private readonly config: ConfigService) {
    this.token =
      this.config.get<string>('TELEGRAM_ALERT_BOT_TOKEN')?.trim() || null;
    this.chatId =
      this.config.get<string>('TELEGRAM_DEVELOPER_CHAT_ID')?.trim() || null;

    // Opt-out must be typed in full, and the absence of credentials is its own
    // off switch — an alert channel that silently disabled itself would be
    // worse than one that was never installed.
    const flag = (
      this.config.get<string>('TELEGRAM_ALERTS_ENABLED') ?? 'true'
    ).toLowerCase();
    this.enabled = flag !== 'false' && !!this.token && !!this.chatId;

    this.env = this.config.get<string>('APP_ENV')?.trim() || 'development';
    this.systemName =
      this.config.get<string>('APP_NAME')?.trim() || 'ITC Sharing';
    /**
     * Alerts are read by a person in Cambodia, so they are stamped in that
     * person's clock rather than the server's UTC. Configurable, because the
     * next person reading them may not be in the same place.
     */
    this.timeZone =
      this.config.get<string>('APP_TIMEZONE')?.trim() || 'Asia/Phnom_Penh';

    /**
     * Forum topics, if the chat is a forum and any are configured.
     *
     * A thread id is a positive integer; anything else is a typo, and a typo
     * here would make Telegram refuse every message in that group. Ignoring
     * the bad value sends to General instead, which is visible and recoverable
     * rather than silent.
     */
    for (const [group, key] of Object.entries(TOPIC_ENV) as [
      TopicGroup,
      string,
    ][]) {
      const raw = Number(this.config.get<string>(key));
      if (Number.isInteger(raw) && raw > 0) this.topics[group] = raw;
    }

    /**
     * Lets a NON-production environment put the actual code in the alert,
     * which makes testing the mail-less path bearable. Two conditions, both
     * required, and the environment check is not something a single stray
     * variable can defeat.
     */
    this.includeSecretsInDev =
      this.env !== 'production' &&
      (
        this.config.get<string>('TELEGRAM_ALERTS_INCLUDE_CODES') ?? ''
      ).toLowerCase() === 'true';
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** True only where it is safe AND asked for. Callers must check before passing a code. */
  get mayIncludeCodes(): boolean {
    return this.enabled && this.includeSecretsInDev;
  }

  // ─── The events this system actually has ─────────────────────────────────

  loginSucceeded(who: LoginAlert, ctx?: RequestCtx) {
    this.queue({
      kind: 'login.ok',
      title: 'Login Successful',
      signature: `login.ok:${who.userId ?? who.login}`,
      fields: {
        USER: who.name,
        LOGIN: who.login,
        ...this.requestFields(ctx),
      },
    });
  }

  /**
   * `reason` is the internal one, not the message the caller was given.
   *
   * Login deliberately answers "Invalid email or password" for both an unknown
   * address and a wrong password. The developer channel is the one place that
   * distinction is safe to make, and it is the difference between someone
   * mistyping their own password and someone working through a list.
   */
  loginFailed(who: LoginAlert & { reason: string }, ctx?: RequestCtx) {
    this.queue({
      kind: 'login.failed',
      title: 'Login Failed',
      signature: `login.failed:${who.reason}:${ctx?.ip ?? '?'}`,
      fields: {
        // Absent for an unknown address — there is no account to name.
        USER: who.name,
        LOGIN: who.login,
        REASON: who.reason,
        ...this.requestFields(ctx),
      },
    });
  }

  registered(email: string, name: string, ctx?: RequestCtx) {
    this.queue({
      kind: 'register',
      title: 'New Registration',
      fields: {
        USER: name,
        LOGIN: email,
        ...this.requestFields(ctx),
      },
    });
  }

  /**
   * A code was mailed. The code itself is included only when
   * TELEGRAM_ALERTS_INCLUDE_CODES is on outside production — see the
   * constructor. In production this says that one was sent, never what it was.
   */
  codeIssued(purpose: 'verify' | 'reset', email: string, code?: string) {
    this.queue({
      kind: 'code.issued',
      title:
        purpose === 'verify' ? 'Verification Code Sent' : 'Reset Code Sent',
      signature: `code.issued:${purpose}:${email}`,
      fields: {
        LOGIN: email,
        PURPOSE: purpose,
        CODE: this.mayIncludeCodes ? code : undefined,
      },
    });
  }

  /** Five wrong guesses against one code — already an ERROR in the security log. */
  codeBurned(purpose: 'verify' | 'reset', email: string) {
    this.queue({
      kind: 'code.burned',
      title: 'Code Burned — Attempt Cap Reached',
      fields: { PURPOSE: purpose, LOGIN: email },
    });
  }

  passwordReset(email: string, sessionsRevoked: number, ctx?: RequestCtx) {
    this.queue({
      kind: 'password.reset',
      title: 'Password Reset',
      fields: {
        LOGIN: email,
        REVOKED: `${sessionsRevoked} session(s)`,
        ...this.requestFields(ctx),
      },
    });
  }

  /** The strongest signal the auth system produces: a refresh token used twice. */
  /**
   * The one alert that still carries raw ids. A reuse means the account may be
   * in two people's hands at once, and the user and family ids are what tie
   * this message to the rows that were revoked — an address would not.
   */
  refreshReuse(userId: string, familyId: string, revoked: number) {
    this.queue({
      kind: 'refresh.reuse',
      title: 'Refresh Token Reuse — Family Revoked',
      fields: {
        'USER ID': userId,
        FAMILY: familyId,
        REVOKED: `${revoked} token(s)`,
      },
    });
  }

  /**
   * An unhandled server failure.
   *
   * Only 5xx reaches here. A 4xx is the API telling a client "no", which is
   * the normal working of a validated, rate-limited, authorising system —
   * forwarding those would turn this channel into a second, worse log.
   */
  serverError(
    method: string,
    url: string,
    status: number,
    message: string,
    email?: string,
    ctx?: RequestCtx,
  ) {
    this.queue({
      kind: 'server.error',
      title: `${status} on ${method} ${url}`,
      // Same route and same message collapse: one broken endpoint hit fifty
      // times is one problem, not fifty.
      signature: `server.error:${method}:${url}:${message.slice(0, 80)}`,
      fields: {
        ERROR: message.slice(0, 300),
        LOGIN: email,
        ...this.requestFields(ctx),
      },
    });
  }

  // ─── Delivery ────────────────────────────────────────────────────────────

  /**
   * BROWSER answers "what made this request" — Chrome, Safari, or a tool like
   * Postman or curl. It replaced a DEVICE line that read "Chrome on macOS"
   * and so repeated the OS line underneath it; two labels now say two things.
   */
  private requestFields(ctx?: RequestCtx) {
    const client = describeClient(ctx?.userAgent);
    return { IP: ctx?.ip, BROWSER: client?.browser, OS: client?.os };
  }

  /**
   * Decide whether this alert is sent, then send it without being awaited.
   *
   * `void` on the promise is the point: the caller is inside a request, and
   * the request must not wait on Telegram or fail with it.
   */
  private queue(alert: Alert): void {
    if (!this.enabled) return;

    const now = Date.now();

    // Fresh window for the global ceiling.
    if (now - this.windowStartedAt >= 60_000) {
      this.windowStartedAt = now;
      this.sentThisWindow = 0;
      this.floodNoticeSent = false;
    }

    const sig = alert.signature ?? alert.kind;
    const seen = this.recent.get(sig);
    if (seen && now - seen.at < DEDUPE_MS) {
      seen.held += 1;
      return;
    }

    if (this.sentThisWindow >= GLOBAL_PER_MIN) {
      if (!this.floodNoticeSent) {
        this.floodNoticeSent = true;
        this.sentThisWindow += 1;
        void this.deliver(
          'server.error',
          `⚠️ <b>Alerts throttled</b>\n${this.escape(this.env)} · more than ${GLOBAL_PER_MIN} in a minute. Further alerts are suppressed until the next minute; the server log has everything.`,
        );
      }
      return;
    }

    const held = seen?.held ?? 0;
    this.recent.set(sig, { at: now, held: 0 });
    this.sentThisWindow += 1;
    this.prune(now);

    void this.deliver(alert.kind, this.render(alert, held));
  }

  /** Old signatures would otherwise accumulate one entry per distinct event forever. */
  private prune(now: number): void {
    if (this.recent.size < 500) return;
    for (const [key, v] of this.recent) {
      if (now - v.at > DEDUPE_MS) this.recent.delete(key);
    }
  }

  /**
   * One shape for every alert: a title, then an aligned block of labels.
   *
   * The block sits inside <pre> because that is the only way Telegram renders
   * a fixed-width column — without it the values wander and the eye loses the
   * left edge, which is the entire point of aligning them. Labels are padded
   * to the longest one PRESENT in this message, so an alert with no user does
   * not carry a gap where a user would have been.
   */
  private render(alert: Alert, heldSincePrevious: number): string {
    const rows: [string, string][] = [
      ['SYSTEM', this.systemName],
      ['ENV', this.env],
      ['DATE', this.stamp()],
      ...Object.entries(alert.fields)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => [k, String(v)] as [string, string]),
    ];

    const width = Math.max(...rows.map(([label]) => label.length));
    const block = rows
      .map(([label, value]) => `${label.padEnd(width)} : ${this.escape(value)}`)
      .join('\n');

    const repeat =
      heldSincePrevious > 0
        ? `\n<i>+${heldSincePrevious} identical suppressed in the last minute</i>`
        : '';

    return `<b>${this.escape(alert.title)}</b>\n<pre>${block}</pre>${repeat}`;
  }

  /**
   * One timestamp for every alert: DD/MM/YYYY, HH:mm:ss in the configured
   * zone. Built with Intl so the zone and its daylight rules are the
   * platform's problem rather than ours.
   */
  private stamp(): string {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: this.timeZone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date());
  }

  /** The message is sent as HTML, so anything interpolated is escaped first. */
  private escape(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private async deliver(kind: AlertKind, text: string): Promise<void> {
    const thread = this.topics[TOPIC_OF[kind]];

    try {
      const res = await fetch(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.chatId,
            // Omitted entirely when no topic is configured: sending
            // message_thread_id to a non-forum chat is an error, not a no-op.
            ...(thread === undefined ? {} : { message_thread_id: thread }),
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) {
        /**
         * Named, because the two likely causes look identical from a status
         * code and have different fixes: a wrong thread id (the topic was
         * deleted or the number is from another group) and a bot that was
         * never added to the group.
         */
        this.logger.warn(
          `Telegram alert rejected: HTTP ${res.status}` +
            (thread === undefined ? '' : ` (topic ${thread}, kind ${kind})`),
        );
      }
    } catch (err) {
      this.logger.warn(
        `Telegram alert failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
