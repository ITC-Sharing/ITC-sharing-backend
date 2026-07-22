import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentsService } from './documents.service';
import { DocumentsController } from './documents.controller';
import { MulterModule } from '@nestjs/platform-express';
import { Upload } from '../../entities/upload.entity';
import { DocumentFile } from '../../entities/document.entity';
import { DocumentTag } from '../../entities/document-tag.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Upload, DocumentFile, DocumentTag]),
    MulterModule.register({ storage: undefined }),
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService],
})
export class DocumentsModule {}
