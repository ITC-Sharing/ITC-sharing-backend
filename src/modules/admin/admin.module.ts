import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { ModerationService } from './moderation.service';
import { AdminGuard } from './guards/admin.guard';
import { ReviewerGuard } from './guards/reviewer.guard';
import { NotificationsModule } from '../notifications/notifications.module';
import { User } from '../../entities/user.entity';
import { Upload } from '../../entities/upload.entity';
import { DocumentFile } from '../../entities/document.entity';
import { Subject } from '../../entities/subject.entity';
import { DepartmentModerator } from '../../entities/department-moderator.entity';
import { RefreshToken } from '../../entities/refresh-token.entity';
import { Book } from '../../entities/book.entity';

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
    ]),
    NotificationsModule,
  ],
  controllers: [AdminController],
  providers: [AdminService, ModerationService, AdminGuard, ReviewerGuard],
  exports: [ModerationService],
})
export class AdminModule {}
