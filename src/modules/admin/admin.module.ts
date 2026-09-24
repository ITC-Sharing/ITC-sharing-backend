import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminController } from './admin.controller';
import { ModerationController } from './moderation.controller';
import { AdminService } from './admin.service';
import { ModerationService } from './moderation.service';
import { AdminGuard } from './guards/admin.guard';
import { ReviewerGuard } from './guards/reviewer.guard';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../settings/settings.module';
import { User } from '../users/entities/user.entity';
import { Upload } from '../documents/entities/upload.entity';
import { DocumentFile } from '../documents/entities/document.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { DepartmentModerator } from './entities/department-moderator.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { Book } from '../books/entities/book.entity';
import { BookRequest } from '../books/entities/book-request.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { Major } from '../majors/entities/major.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Upload,
      DocumentFile,
      Subject,
      DepartmentModerator,
      RefreshToken,
      Book,
      BookRequest,
      Notification,
      Major,
    ]),
    NotificationsModule,
    SettingsModule,
  ],
  controllers: [AdminController, ModerationController],
  providers: [AdminService, ModerationService, AdminGuard, ReviewerGuard],
  exports: [ModerationService],
})
export class AdminModule {}
