import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MajorsService } from './majors.service';
import { MajorsController } from './majors.controller';
import { Major } from '../../entities/major.entity';
import { User } from '../../entities/user.entity';
import { AdminGuard } from '../admin/guards/admin.guard';

@Module({
  // User is here only so AdminGuard can resolve its repository.
  imports: [TypeOrmModule.forFeature([Major, User])],
  controllers: [MajorsController],
  providers: [MajorsService, AdminGuard],
})
export class MajorsModule {}
