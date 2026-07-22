import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotificationsService } from './notifications.service';

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
