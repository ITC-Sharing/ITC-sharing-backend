import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentsService } from './documents.service';
import { DocumentsController } from './documents.controller';
import { MulterModule } from '@nestjs/platform-express';
import { Upload } from '../../entities/upload.entity';
import { DocumentFile } from '../../entities/document.entity';
import { User } from '../../entities/user.entity';
import { Major } from '../../entities/major.entity';
import { StagedFile } from '../../entities/staged-file.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Upload, DocumentFile, User, Major, StagedFile]),
    MulterModule.register({ storage: undefined }),
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService],
})
export class DocumentsModule {}
