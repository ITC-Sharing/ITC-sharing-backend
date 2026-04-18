import { Module } from '@nestjs/common';
import { MajorsService } from './majors.service';
import { MajorsController } from './majors.controller';

@Module({
  controllers: [MajorsController],
  providers: [MajorsService],
})
export class MajorsModule {}
