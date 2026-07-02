import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { BooksService } from './books.service';
import { BooksController } from './books.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [MulterModule.register({ storage: undefined }), NotificationsModule],
  controllers: [BooksController],
  providers: [BooksService],
})
export class BooksModule {}
