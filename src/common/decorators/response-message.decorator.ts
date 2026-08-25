import { SetMetadata } from '@nestjs/common';

export const RESPONSE_MESSAGE = 'response_message';

/**
 * Overrides the `message` TransformInterceptor puts in the envelope.
 *
 *   @ResponseMessage('Document uploaded')
 *   @Post()
 *   upload() { … }
 *
 * Works on a single route or on a whole controller; the route wins.
 */
export const ResponseMessage = (message: string) =>
  SetMetadata(RESPONSE_MESSAGE, message);
