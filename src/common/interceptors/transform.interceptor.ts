import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { RESPONSE_MESSAGE } from '../decorators/response-message.decorator';

/** The envelope every successful response is wrapped in. */
export interface ApiResponse<T> {
  success: true;
  data: T;
  message: string;
}

export const DEFAULT_RESPONSE_MESSAGE = 'Request successful';

/**
 * Wraps every successful response in `{ success, data, message }`.
 *
 * Whatever the handler returns — an object, an array, a string, a boolean or
 * null — goes into `data` untouched; nothing is renamed, merged or flattened.
 * Handlers stay free to return plain values, and Nest awaits Promises before
 * this runs, so async controllers need no special treatment.
 *
 * Errors don't pass through here: an exception skips the interceptor's map and
 * is rendered by the exception filter, so failures keep their own shape.
 *
 * Per-route wording comes from @ResponseMessage('…'); everything else gets
 * DEFAULT_RESPONSE_MESSAGE.
 */
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<
  T,
  ApiResponse<T>
> {
  constructor(private readonly reflector: Reflector) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiResponse<T>> {
    // Route handler first, then the controller — so a controller-wide message
    // can be overridden on a single route.
    const message =
      this.reflector.getAllAndOverride<string>(RESPONSE_MESSAGE, [
        context.getHandler(),
        context.getClass(),
      ]) ?? DEFAULT_RESPONSE_MESSAGE;

    return next.handle().pipe(
      map((data) => ({
        success: true as const,
        data,
        message,
      })),
    );
  }
}
