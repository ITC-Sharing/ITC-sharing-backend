import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SubjectsService } from './subjects.service';
import { SubjectsController } from './subjects.controller';
import { Subject } from './entities/subject.entity';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  // NotificationsModule: reviewers are told when a subject is submitted.
  imports: [TypeOrmModule.forFeature([Subject]), NotificationsModule],
  controllers: [SubjectsController],
  providers: [SubjectsService],
})
export class SubjectsModule {}
