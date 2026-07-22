import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './guards/admin.guard';
import { NotificationsModule } from '../notifications/notifications.module';
import { User } from '../../entities/user.entity';
import { Upload } from '../../entities/upload.entity';
import { DocumentFile } from '../../entities/document.entity';
import { Subject } from '../../entities/subject.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Upload, DocumentFile, Subject]),
    NotificationsModule,
  ],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule {}
