import { Module } from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { DocumentsController } from './documents.controller';
import { MulterModule } from '@nestjs/platform-express';

@Module({
  imports: [MulterModule.register({ storage: undefined })],
  controllers: [DocumentsController],
  providers: [DocumentsService],
})
export class DocumentsModule {}
