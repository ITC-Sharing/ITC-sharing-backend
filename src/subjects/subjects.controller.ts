import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
  BadRequestException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SubjectsService } from './subjects.service';
import { CreateSubjectDto } from './dto/create-subject.dto';

const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

@Controller('subjects')
export class SubjectsController {
  constructor(private readonly subjectsService: SubjectsService) {}

  /**
   * GET /subjects?major_id=<uuid>
   * Public — used to populate subject dropdowns filtered by major
   */
  @Get()
  findByMajor(
    @Query('major_id') majorId: string,
    @Query('year_level') yearLevel?: string, // ← add this
  ) {
    if (!majorId) throw new BadRequestException('major_id is required');
    return this.subjectsService.findByMajor(
      majorId,
      yearLevel ? Number(yearLevel) : undefined,
    );
  }

  /**
   * POST /subjects
   * Any logged-in user can contribute a missing subject
   * Multipart form-data supported: image + subject fields
   */
  @UseGuards(JwtAuthGuard)
  @Post()
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_IMAGE_SIZE_BYTES },
      fileFilter: (_req, file, cb) => {
        if (ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new Error('Unsupported image type'), false);
        }
      },
    }),
  )
  create(
    @Body() dto: CreateSubjectDto,
    @UploadedFile() image?: Express.Multer.File,
  ) {
    return this.subjectsService.create(dto, image);
  }
}
