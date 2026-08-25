import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

/**
 * Logs requests that succeed — one line with method, URL, status and how long
 * the handler took.
 *
 * Failures are NOT logged here, and not because they can't be: an interceptor
 * simply never sees the most common ones. Guards run before interceptors, so a
 * rejected JWT skips this chain entirely. AllExceptionsFilter catches every
 * failure instead, wherever it came from — the two together cover both halves
 * without logging anything twice.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // WebSocket events have no request/response to describe.
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: { sub?: string } }>();
    const startedAt = Date.now();

    return next.handle().pipe(
      tap(() => {
        const status = http.getResponse<Response>().statusCode;
        const who = request.user?.sub ? ` user=${request.user.sub}` : '';
        this.logger.log(
          `${request.method} ${request.url} → ${status} (${Date.now() - startedAt}ms)${who}`,
        );
      }),
    );
  }
}
