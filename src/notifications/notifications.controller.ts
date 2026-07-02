import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotificationsService, PushSubscriptionDto } from './notifications.service';

type AuthenticatedRequest = { user: { sub: string; email: string } };

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  /** GET /notifications */
  @Get()
  getAll(@Request() req: AuthenticatedRequest) {
    return this.notificationsService.getForUser(req.user.sub);
  }

  /** GET /notifications/vapid-public-key — frontend needs this to subscribe */
  @Get('vapid-public-key')
  getVapidKey() {
    return { key: process.env.VAPID_PUBLIC_KEY };
  }

  /** POST /notifications/push-subscribe */
  @Post('push-subscribe')
  pushSubscribe(@Request() req: AuthenticatedRequest, @Body() body: PushSubscriptionDto) {
    return this.notificationsService.savePushSubscription(req.user.sub, body);
  }

  /** PATCH /notifications/read-all */
  @Patch('read-all')
  markAllRead(@Request() req: AuthenticatedRequest) {
    return this.notificationsService.markAllRead(req.user.sub);
  }

  /** PATCH /notifications/:id/read */
  @Patch(':id/read')
  markRead(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notificationsService.markRead(req.user.sub, id);
  }
}
