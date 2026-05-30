import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DocumentsService } from './documents.service';
import { CreateDocumentDto, DOC_TYPES } from './dto/create-document.dto';
import { QueryDocumentsDto } from './dto/query-documents.dto';

type AuthenticatedRequest = {
  user: {
    sub: string;
    email: string;
  };
};

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/jpeg',
  'image/png',
];
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_FILES_PER_UPLOAD = 10;

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  /**
   * GET /documents/types  — public, no auth required
   * Returns the list of valid document type values from the enum.
   */
  @Get('types')
  getTypes() {
    return { types: DOC_TYPES };
  }

  /**
   * POST /documents
   * Multipart upload: files + JSON fields in form-data
   */
  @UseGuards(JwtAuthGuard)
  @Post()
  @UseInterceptors(
    FilesInterceptor('files', MAX_FILES_PER_UPLOAD, {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_SIZE_BYTES },
      fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new Error('Unsupported file type'), false);
        }
      },
    }),
  )
  upload(
    @Request() req: AuthenticatedRequest,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() dto: CreateDocumentDto,
  ) {
    return this.documentsService.uploadMany(req.user.sub, dto, files);
  }

  /**
   * GET /documents?major_id=&subject_id=&doc_type=&search=
   */
  @UseGuards(JwtAuthGuard)
  @Get()
  findAll(@Query() query: QueryDocumentsDto) {
    return this.documentsService.findAll(query);
  }

  /**
   * GET /documents/saved  — must be above :id to avoid route conflict
   */
  @UseGuards(JwtAuthGuard)
  @Get('saved')
  getSaved(@Request() req: AuthenticatedRequest) {
    return this.documentsService.getSaved(req.user.sub);
  }

  /**
   * GET /documents/:id
   * Also increments view count
   */
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const doc = await this.documentsService.findOne(id);
    void this.documentsService.incrementView(id); // fire-and-forget, don't await
    return doc;
  }

  /**
   * PATCH /documents/:id/download
   * Called by frontend when user actually downloads the file
   */
  @UseGuards(JwtAuthGuard)
  @Patch(':id/download')
  incrementDownload(@Param('id', ParseUUIDPipe) id: string) {
    return this.documentsService.incrementDownload(id);
  }

  /**
   * POST /documents/:id/save
   */
  @UseGuards(JwtAuthGuard)
  @Post(':id/save')
  save(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.documentsService.save(req.user.sub, id);
  }

  /**
   * DELETE /documents/:id/save
   */
  @UseGuards(JwtAuthGuard)
  @Delete(':id/save')
  unsave(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.documentsService.unsave(req.user.sub, id);
  }

  /**
   * DELETE /documents/:id
   * Soft delete — uploader only
   */
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  delete(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.documentsService.delete(id, req.user.sub);
  }
}
