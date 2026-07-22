import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { MajorsService } from './majors.service';
import { CreateMajorDto } from './dto/create-major.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../admin/guards/admin.guard';

const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

@Controller('majors')
export class MajorsController {
  constructor(private readonly majorsService: MajorsService) {}

  /**
   * GET /majors
   * Public — no auth required (used on registration screen)
   */
  @Get()
  findAll() {
    return this.majorsService.findAll();
  }

  /**
   * POST /majors
   * Admin only — majors are reference data the whole navigation tree hangs off.
   *
   * Accepts JSON, or multipart/form-data with an `image` file. When a file is
   * sent it is uploaded and wins over any `image_url` in the body.
   */
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post()
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_IMAGE_SIZE_BYTES },
      fileFilter: (_req, file, cb) => {
        if (ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype)) {
          cb(null, true);
        } else {
          // A plain Error here surfaces as a 500; this keeps it a 400.
          cb(
            new BadRequestException(
              `Unsupported image type '${file.mimetype}' — use JPEG, PNG or WebP`,
            ),
            false,
          );
        }
      },
    }),
  )
  create(
    @Body() dto: CreateMajorDto,
    @UploadedFile() image?: Express.Multer.File,
  ) {
    return this.majorsService.create(dto, image);
  }
}
