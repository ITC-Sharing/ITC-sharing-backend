import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RateLimitTier } from '../../common/rate-limit/rate-limit.decorator';
import { TelegramService } from './telegram.service';

type AuthenticatedRequest = { user: { sub: string; email: string } };

@Controller('telegram')
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  /**
   * GET /telegram/status — what Settings renders.
   *
   * `available` is separate from `connected`: with no bot configured there is
   * nothing to connect to, and the page says so rather than offering a button
   * that cannot work.
   */
  @Get('status')
  @UseGuards(JwtAuthGuard)
  status(@Request() req: AuthenticatedRequest) {
    return this.telegram.status(req.user.sub);
  }

  /**
   * POST /telegram/link-token — start linking.
   *
   * Authenticated, because the token it returns is what proves to the bot which
   * account a chat belongs to. The bot token itself never leaves the server;
   * the client only ever sees a t.me URL.
   */
  @RateLimitTier('telegram-link')
  @Post('link-token')
  @UseGuards(JwtAuthGuard)
  createLinkToken(@Request() req: AuthenticatedRequest) {
    this.telegram.assertConfigured();
    return this.telegram.createLinkToken(req.user.sub);
  }

  /** DELETE /telegram/link — stop delivering to Telegram. */
  @Delete('link')
  @UseGuards(JwtAuthGuard)
  unlink(@Request() req: AuthenticatedRequest) {
    return this.telegram.unlink(req.user.sub);
  }

  /**
   * POST /telegram/webhook — where Telegram delivers updates.
   *
   * Public by necessity, so the shared secret is the whole of the
   * authentication: Telegram echoes the value registered with setWebhook in
   * this header, and anything without it is dropped.
   *
   * Always answers 200. A non-2xx tells Telegram to redeliver, which turns one
   * malformed update into a retry loop — and there is nothing a caller could do
   * with an error here anyway.
   */
  @RateLimitTier('telegram-webhook')
  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() update: unknown,
  ) {
    if (!this.telegram.verifyWebhookSecret(secret)) return { ok: true };
    await this.telegram.handleUpdate(update);
    return { ok: true };
  }
}
