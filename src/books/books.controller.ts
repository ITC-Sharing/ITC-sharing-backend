import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { BooksService } from './books.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateBookDto } from './dto/create-book.dto';
import { UpdateBookDto } from './dto/update-book.dto';
import { CreateRequestDto } from './dto/create-request.dto';
import { DeclineRequestDto } from './dto/decline-request.dto';

type AuthReq = { user: { sub: string } };

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_COVER_SIZE = 20 * 1024 * 1024; // 20 MB

@Controller('books')
export class BooksController {
  constructor(private readonly booksService: BooksService) {}

  @UseGuards(JwtAuthGuard)
  @Post('upload-cover')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_COVER_SIZE },
      fileFilter: (_req, file, cb) => {
        if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new BadRequestException('Only JPEG, PNG, and WebP images are allowed'), false);
        }
      },
    }),
  )
  uploadCover(@Request() req: AuthReq, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file provided');
    return this.booksService.uploadCover(req.user.sub, file);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  donate(@Request() req: AuthReq, @Body() dto: CreateBookDto) {
    return this.booksService.donate(req.user.sub, dto);
  }

  @Get()
  findAll(@Query('major_id') majorId?: string) {
    return this.booksService.findAll(majorId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('mine')
  getMyBooks(@Request() req: AuthReq, @Query('filter') filter?: string) {
    const allowed = ['all', 'pending', 'donated'] as const;
    const safe = (allowed as readonly string[]).includes(filter ?? '')
      ? (filter as 'all' | 'pending' | 'donated')
      : 'all';
    return this.booksService.getMyBooks(req.user.sub, safe);
  }

  @UseGuards(JwtAuthGuard)
  @Get('stats')
  getStats(@Request() req: AuthReq) {
    return this.booksService.getBookStats(req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Get('requests/incoming')
  getIncomingRequests(@Request() req: AuthReq) {
    return this.booksService.getIncomingRequests(req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Get('requests/outgoing')
  getOutgoingRequests(@Request() req: AuthReq, @Query('status') status?: string) {
    const allowed = ['pending', 'accepted', 'declined'] as const;
    const safe = (allowed as readonly string[]).includes(status ?? '')
      ? (status as 'pending' | 'accepted' | 'declined')
      : undefined;
    return this.booksService.getOutgoingRequests(req.user.sub, safe);
  }

  @UseGuards(JwtAuthGuard)
  @Get('request/:requestId')
  getRequestDetail(@Param('requestId') requestId: string, @Request() req: AuthReq) {
    return this.booksService.getRequestDetail(requestId, req.user.sub);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.booksService.findOne(id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  update(@Param('id') id: string, @Request() req: AuthReq, @Body() dto: UpdateBookDto) {
    return this.booksService.update(id, req.user.sub, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(@Param('id') id: string, @Request() req: AuthReq) {
    return this.booksService.remove(id, req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/request')
  request(@Param('id') id: string, @Request() req: AuthReq, @Body() dto: CreateRequestDto) {
    return this.booksService.request(id, req.user.sub, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/request/:requestId/accept')
  accept(@Param('id') id: string, @Param('requestId') requestId: string, @Request() req: AuthReq) {
    return this.booksService.accept(id, requestId, req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/request/:requestId/decline')
  decline(
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Request() req: AuthReq,
    @Body() dto: DeclineRequestDto,
  ) {
    return this.booksService.decline(id, requestId, req.user.sub, dto.reason);
  }
}
