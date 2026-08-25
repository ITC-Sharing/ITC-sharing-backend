import { ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Request } from 'express';

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

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() === 'http') {
      const request = host
        .switchToHttp()
        .getRequest<Request & { user?: { sub?: string } }>();
      const status =
        exception instanceof HttpException ? exception.getStatus() : 500;
      const reason =
        exception instanceof Error ? exception.message : String(exception);
      const who = request.user?.sub ? ` user=${request.user.sub}` : '';
      const line = `${request.method} ${request.url} → ${status}${who} — ${reason}`;

      if (status >= 500) {
        this.logger.error(
          line,
          exception instanceof Error ? exception.stack : undefined,
        );
      } else {
        this.logger.warn(line);
      }
    }

    super.catch(exception, host);
  }
}
