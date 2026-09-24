import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Request, Response } from 'express';
import { DevAlertService } from '../alerts/dev-alert.service';
import { contextFrom } from '../alerts/request-context';

/**
 * Logs every failed request, then hands the response back to Nest's own filter
 * so the body shape is unchanged.
 *
 * This lives in a filter rather than an interceptor because guards run BEFORE
 * interceptors: a rejected JWT never enters the interceptor chain, so an
 * interceptor's catchError never sees the 401 — which is most of the failures
 * worth reading. A filter sits at the end of every path and catches the lot.
 *
 * Severity follows the status: a 4xx is the client being told "no" (bad input,
 * expired token) and gets one WARN line; a 5xx is the server breaking and gets
 * ERROR with the stack.
 */
@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('HTTP');

  /**
   * Optional so the filter still works anywhere the alert module is not
   * loaded — a unit test, say. Nest injects it in the running app.
   */
  constructor(private readonly alerts?: DevAlertService) {
    super();
  }

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() === 'http') {
      const request = host
        .switchToHttp()
        // `email` as well as `sub`: JwtStrategy.validate returns both, and an
        // alert names the account by address rather than by row id.
        .getRequest<Request & { user?: { sub?: string; email?: string } }>();
      const status: number =
        exception instanceof HttpException
          ? exception.getStatus()
          : HttpStatus.INTERNAL_SERVER_ERROR;
      const reason =
        exception instanceof Error ? exception.message : String(exception);
      const who = request.user?.sub ? ` user=${request.user.sub}` : '';
      const line = `${request.method} ${request.url} → ${status}${who} — ${reason}`;

      // A 429 must say when to come back. The throw sites carry the number in
      // `cause` rather than reaching for the response themselves — a service
      // should not know it is speaking HTTP.
      if (status === Number(HttpStatus.TOO_MANY_REQUESTS)) {
        const retryAfter = retryAfterOf(exception);
        if (retryAfter !== null) {
          host
            .switchToHttp()
            .getResponse<Response>()
            .setHeader('Retry-After', String(retryAfter));
        }
      }

      if (status >= 500) {
        this.logger.error(
          line,
          exception instanceof Error ? exception.stack : undefined,
        );
        /**
         * 5xx only. A 4xx is the API telling a client "no" — a rejected
         * password, a refused upload, a rate limit — which is this system
         * working, and forwarding those would make the channel a worse copy
         * of the log. The alert never carries the stack, the headers or the
         * body: a stack can hold a connection string, and the body is where
         * passwords live.
         */
        this.alerts?.serverError(
          request.method,
          request.url,
          status,
          reason,
          request.user?.email,
          contextFrom(request),
        );
      } else {
        this.logger.warn(line);
      }
    }

    super.catch(exception, host);
  }
}

/** Seconds from an exception's `cause`, when a throw site supplied one. */
function retryAfterOf(exception: unknown): number | null {
  if (!(exception instanceof HttpException)) return null;
  const cause = exception.cause as { retryAfter?: unknown } | undefined;
  const seconds = cause?.retryAfter;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? Math.ceil(seconds)
    : null;
}
