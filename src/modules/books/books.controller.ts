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
import { RateLimitTier } from '../../common/rate-limit/rate-limit.decorator';

type AuthReq = { user: { sub: string } };

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_COVER_SIZE = 20 * 1024 * 1024; // 20 MB

@Controller('books')
export class BooksController {
  constructor(private readonly booksService: BooksService) {}

  @UseGuards(JwtAuthGuard)
  @RateLimitTier('upload')
  @Post('upload-cover')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_COVER_SIZE },
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
  uploadCover(
    @Request() req: AuthReq,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    return this.booksService.uploadCover(req.user.sub, file);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  donate(@Request() req: AuthReq, @Body() dto: CreateBookDto) {
    return this.booksService.donate(req.user.sub, dto);
  }

  /**
   * Every book on offer, the donor's own listings included — the detail page is
   * where requesting is refused for your own book, not this list.
   *
   * Viewer-aware for one case only: a book with a pending request stays listed
   * for the donor and the requester, and is hidden from everyone else.
   */
  @UseGuards(JwtAuthGuard)
  @Get()
  findAll(
    @Request() req: AuthReq,
    @Query('major_id') majorId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.booksService.findAll(
      majorId,
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
      req.user.sub,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('mine')
  getMyBooks(@Request() req: AuthReq, @Query('filter') filter?: string) {
    const allowed = [
      'all',
      'pending',
      'donated',
      'available',
      'received',
      'reserved',
    ] as const;
    const safe = (allowed as readonly string[]).includes(filter ?? '')
      ? (filter as (typeof allowed)[number])
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
  getOutgoingRequests(
    @Request() req: AuthReq,
    @Query('status') status?: string,
  ) {
    const allowed = ['pending', 'accepted', 'declined'] as const;
    const safe = (allowed as readonly string[]).includes(status ?? '')
      ? (status as 'pending' | 'accepted' | 'declined')
      : undefined;
    return this.booksService.getOutgoingRequests(req.user.sub, safe);
  }

  @UseGuards(JwtAuthGuard)
  @Get('request/:requestId')
  getRequestDetail(
    @Param('requestId') requestId: string,
    @Request() req: AuthReq,
  ) {
    return this.booksService.getRequestDetail(requestId, req.user.sub);
  }

  /**
   * Guarded so the donor can be recognised: only they are told who has a
   * request pending on their book. The route is already behind requiresAuth
   * on the client.
   */
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: AuthReq) {
    return this.booksService.findOne(id, req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Request() req: AuthReq,
    @Body() dto: UpdateBookDto,
  ) {
    return this.booksService.update(id, req.user.sub, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(@Param('id') id: string, @Request() req: AuthReq) {
    return this.booksService.remove(id, req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @RateLimitTier('book-request')
  @Post(':id/request')
  request(
    @Param('id') id: string,
    @Request() req: AuthReq,
    @Body() dto: CreateRequestDto,
  ) {
    return this.booksService.request(id, req.user.sub, dto);
  }

  /**
   * Accept a request. One click — where and when is settled on Telegram, so
   * there is nothing to fill in. The book becomes reserved, not donated.
   */
  @UseGuards(JwtAuthGuard)
  @Patch(':id/request/:requestId/accept')
  accept(
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Request() req: AuthReq,
  ) {
    return this.booksService.accept(id, requestId, req.user.sub);
  }

  /**
   * Call off a reservation. Either side may: the receiver who never collected,
   * or the donor who changed their mind. The book returns to available.
   */
  @UseGuards(JwtAuthGuard)
  @Patch(':id/request/:requestId/cancel')
  cancelRequest(
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Request() req: AuthReq,
  ) {
    return this.booksService.cancel(id, requestId, req.user.sub);
  }

  /**
   * The RECEIVER confirms the book changed hands. This is what marks it
   * donated — acceptance only reserves it.
   */
  @UseGuards(JwtAuthGuard)
  @Patch(':id/request/:requestId/complete')
  complete(
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Request() req: AuthReq,
  ) {
    return this.booksService.complete(id, requestId, req.user.sub);
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
