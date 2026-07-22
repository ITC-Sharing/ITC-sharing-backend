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
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DocumentsService } from './documents.service';
import { CreateDocumentDto, DOC_TYPES } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
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
  'application/zip',
  'application/x-zip-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
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
   * GET /documents/mine  — user's pending + rejected submissions
   */
  @UseGuards(JwtAuthGuard)
  @Get('mine')
  findMine(@Request() req: AuthenticatedRequest) {
    return this.documentsService.findMine(req.user.sub);
  }

  /**
   * GET /documents/stats — totals for the dashboard.
   *
   * Must stay above @Get(':id') — route order decides, and 'stats' would
   * otherwise be captured as an :id (and rejected by ParseUUIDPipe).
   */
  @UseGuards(JwtAuthGuard)
  @Get('stats')
  getStats(@Request() req: AuthenticatedRequest) {
    return this.documentsService.getStats(req.user.sub);
  }

  /**
   * GET /documents/:id
   */
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.documentsService.findOne(id);
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

  /**
   * PATCH /documents/:id
   * Edit an upload's metadata (uploader only). Re-submits it for review.
   */
  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDocumentDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.documentsService.update(id, req.user.sub, dto);
  }

  /**
   * POST /documents/:id/files — add files to an existing upload (uploader only).
   */
  @UseGuards(JwtAuthGuard)
  @Post(':id/files')
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
  addFiles(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Request() req: AuthenticatedRequest,
  ) {
    return this.documentsService.addFiles(id, req.user.sub, files);
  }

  /**
   * DELETE /documents/files/:fileId — remove a single file (uploader only).
   */
  @UseGuards(JwtAuthGuard)
  @Delete('files/:fileId')
  removeFile(
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.documentsService.removeFile(fileId, req.user.sub);
  }
}
