import { ConsoleLogger } from '@nestjs/common';
import { redactObject, redactText } from './redact';

/**
 * The application logger, with redaction applied to everything that passes
 * through it.
 *
 * Wiring the scrubber into two chokepoints — the request interceptor and the
 * exception filter — covers the two paths every HTTP request takes, and misses
 * every log line written anywhere else. There are about fifty of those, and the
 * count only goes up: a service that interpolates a driver error today is one
 * commit away from interpolating one that quotes its parameters.
 *
 * So the guarantee is moved down a layer. Nest routes every `Logger` call
 * through the instance given to `app.useLogger()`, which makes this the last
 * point before text reaches stdout and the only place the rule has to hold.
 * A new log line is scrubbed because it is a log line, not because whoever
 * wrote it remembered.
 *
 * This does NOT excuse deliberately logging a secret. redactText matches keyed
 * values and known shapes; it cannot know that `code for x is 481920` is an
 * OTP. Defence in depth means both — do not write the secret, and scrub what
 * is written anyway.
 */
export class RedactingLogger extends ConsoleLogger {
  /**
   * Scrub one argument.
   *
   * Errors are rebuilt rather than mutated: the caller is still using the
   * object, and stripping a live exception's message would turn a logging
   * concern into an application bug.
   */
  private clean(value: unknown): unknown {
    if (typeof value === 'string') return redactText(value);
    if (value instanceof Error) {
      const copy = new Error(redactText(value.message));
      copy.name = value.name;
      copy.stack = value.stack ? redactText(value.stack) : undefined;
      return copy;
    }
    if (value !== null && typeof value === 'object') return redactObject(value);
    return value;
  }

  private cleanAll(params: unknown[]): unknown[] {
    return params.map((p) => this.clean(p));
  }

  log(message: unknown, ...rest: unknown[]): void {
    super.log(this.clean(message), ...this.cleanAll(rest));
  }

  error(message: unknown, ...rest: unknown[]): void {
    super.error(this.clean(message), ...this.cleanAll(rest));
  }

  warn(message: unknown, ...rest: unknown[]): void {
    super.warn(this.clean(message), ...this.cleanAll(rest));
  }

  debug(message: unknown, ...rest: unknown[]): void {
    super.debug(this.clean(message), ...this.cleanAll(rest));
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    super.verbose(this.clean(message), ...this.cleanAll(rest));
  }

  fatal(message: unknown, ...rest: unknown[]): void {
    super.fatal(this.clean(message), ...this.cleanAll(rest));
  }
}
