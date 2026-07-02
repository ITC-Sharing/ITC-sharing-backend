import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_AVATAR_SIZE = 20 * 1024 * 1024; // 20 MB

type AuthenticatedRequest = {
  user: {
    sub: string;
    email: string;
  };
};

@UseGuards(JwtAuthGuard) // All routes in this controller require a valid JWT
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * GET /users/me
   * Returns the full profile of the currently authenticated user.
   */
  @Get('me')
  getMe(@Request() req: AuthenticatedRequest) {
    return this.usersService.getMe(req.user.sub);
  }

  /**
   * PATCH /users/me
   * Partially updates the authenticated user's profile.
   * All fields are optional — only provided fields are written.
   */
  @Patch('me')
  updateMe(@Request() req: AuthenticatedRequest, @Body() dto: UpdateUserDto) {
    return this.usersService.updateMe(req.user.sub, dto);
  }

  /**
   * POST /users/avatar
   * Uploads a new profile picture and returns its public URL.
   */
  @Post('avatar')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_AVATAR_SIZE },
      fileFilter: (_req, file, cb) => {
        if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(
            new BadRequestException(
              'Only JPEG, PNG, and WebP images are allowed',
            ),
            false,
          );
        }
      },
    }),
  )
  uploadAvatar(
    @Request() req: AuthenticatedRequest,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    return this.usersService.uploadAvatar(req.user.sub, file);
  }
}
