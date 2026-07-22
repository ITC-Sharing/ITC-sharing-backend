import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Book } from '../../entities/book.entity';
import { BookRequest } from '../../entities/book-request.entity';
import { Notification } from '../../entities/notification.entity';
import { User } from '../../entities/user.entity';
import { BUCKETS, StorageService } from '../storage/storage.service';
import { pgCode } from '../../common/utils/pg-error';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateBookDto } from './dto/create-book.dto';
import { UpdateBookDto } from './dto/update-book.dto';
import { CreateRequestDto } from './dto/create-request.dto';

@Injectable()
export class BooksService {
  constructor(
    @InjectRepository(Book)
    private readonly books: Repository<Book>,
    @InjectRepository(BookRequest)
    private readonly requests: Repository<BookRequest>,
    @InjectRepository(Notification)
    private readonly notificationsRepo: Repository<Notification>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
  ) {}

  // Shape a Book (+ donor + major relations) like the old Supabase BOOK_SELECT.
  private bookShape(b: Book) {
    return {
      id: b.id,
      title: b.title,
      description: b.description,
      contact: b.contact,
      status: b.status,
      cover_image_url: b.cover_image_url,
      created_at: b.created_at,
      majors: b.major ? { id: b.major.id, acronym: b.major.acronym } : null,
      users: b.donor
        ? {
            id: b.donor.id,
            first_name: b.donor.first_name,
            last_name: b.donor.last_name,
            avatar_url: b.donor.avatar_url,
          }
        : null,
    };
  }

  private async loadBookShape(id: string) {
    const book = await this.books.findOne({
      where: { id },
      relations: { donor: true, major: true },
    });
    return book ? this.bookShape(book) : null;
  }

  // ─── Donate (list) a book ──────────────────────────────────────────────────

  async donate(donorId: string, dto: CreateBookDto) {
    let saved: Book;
    try {
      saved = await this.books.save(
        this.books.create({
          donor_id: donorId,
          major_id: dto.department,
          title: dto.title,
          description: dto.description ?? null,
          contact: dto.contact ?? null,
          cover_image_url: dto.cover_image_url ?? null,
          status: 'available',
        }),
      );
    } catch (err) {
      if (pgCode(err) === '23503')
        throw new BadRequestException('Invalid department');
      throw new InternalServerErrorException('Failed to list book');
    }

    return this.loadBookShape(saved.id);
  }

  // ─── List available books ──────────────────────────────────────────────────

  async findAll(majorId?: string) {
    let books: Book[];
    try {
      const qb = this.books
        .createQueryBuilder('b')
        .leftJoinAndSelect('b.donor', 'donor')
        .leftJoinAndSelect('b.major', 'major')
        .where('b.status = :status', { status: 'available' })
        .orderBy('b.created_at', 'DESC');
      if (majorId) qb.andWhere('b.major_id = :majorId', { majorId });
      books = await qb.getMany();
    } catch {
      throw new InternalServerErrorException('Failed to fetch books');
    }

    const bookIds = books.map((b) => b.id);
    const activeBookIds = new Set<string>();
    if (bookIds.length) {
      const activeRequests = await this.requests.find({
        where: { book_id: In(bookIds), status: In(['pending', 'accepted']) },
        select: { book_id: true },
      });
      for (const r of activeRequests) activeBookIds.add(r.book_id);
    }

    return books.map((b) => ({
      ...this.bookShape(b),
      has_active_request: activeBookIds.has(b.id),
    }));
  }

  // ─── Get single book ───────────────────────────────────────────────────────

  async findOne(id: string) {
    const book = await this.books.findOne({
      where: { id },
      relations: { donor: true, major: true },
    });

    if (!book) throw new NotFoundException('Book not found');

    const activeRequest = await this.requests.findOne({
      where: { book_id: id, status: In(['pending', 'accepted']) },
      select: { id: true },
    });

    return { ...this.bookShape(book), has_active_request: !!activeRequest };
  }

  // ─── Update own book ───────────────────────────────────────────────────────

  async update(id: string, userId: string, dto: UpdateBookDto) {
    const book = await this.books.findOne({
      where: { id },
      select: { id: true, donor_id: true, status: true },
    });

    if (!book) throw new NotFoundException('Book not found');
    if (book.donor_id !== userId) throw new ForbiddenException('Not your book');
    if (book.status !== 'available')
      throw new BadRequestException('Only available books can be edited');

    const { department, ...rest } = dto;
    const patch: Partial<Book> = { ...rest };
    if (department) patch.major_id = department;

    try {
      await this.books.update({ id }, patch);
    } catch {
      throw new InternalServerErrorException('Failed to update book');
    }
    return this.loadBookShape(id);
  }

  // ─── Delete own book ───────────────────────────────────────────────────────

  async remove(id: string, userId: string) {
    const book = await this.books.findOne({
      where: { id },
      select: { id: true, donor_id: true, status: true },
    });

    if (!book) throw new NotFoundException('Book not found');
    if (book.donor_id !== userId) throw new ForbiddenException('Not your book');
    if (book.status === 'donated')
      throw new BadRequestException('Donated books cannot be deleted');

    // Remove notifications that point to this book's requests — once the book
    // (and its requests, via cascade) is deleted they'd become dead links that
    // 404 when a recipient opens them.
    const reqs = await this.requests.find({
      where: { book_id: id },
      select: { id: true },
    });
    const reqIds = reqs.map((r) => r.id);
    if (reqIds.length) {
      await this.notificationsRepo.delete({
        ref_type: 'book_request',
        ref_id: In(reqIds),
      });
    }

    try {
      await this.books.delete({ id });
    } catch {
      throw new InternalServerErrorException('Failed to delete book');
    }

    return { message: 'Book deleted' };
  }

  // ─── Request a book ────────────────────────────────────────────────────────

  async request(bookId: string, requesterId: string, dto: CreateRequestDto) {
    const book = await this.books.findOne({
      where: { id: bookId },
      select: { id: true, donor_id: true, status: true, title: true },
    });

    if (!book) throw new NotFoundException('Book not found');
    if (book.status !== 'available')
      throw new BadRequestException('Book is not available');
    if (book.donor_id === requesterId)
      throw new ForbiddenException('You cannot request your own book');

    const existing = await this.requests.findOne({
      where: { book_id: bookId, status: In(['pending', 'accepted']) },
      select: { id: true },
    });

    if (existing)
      throw new BadRequestException('This book already has an active request');

    const requester = await this.users.findOne({
      where: { id: requesterId },
      select: { first_name: true, last_name: true },
    });

    let saved: BookRequest;
    try {
      saved = await this.requests.save(
        this.requests.create({
          book_id: bookId,
          requester_id: requesterId,
          message: dto.message ?? null,
          contact: dto.contact,
          status: 'pending',
        }),
      );
    } catch {
      throw new InternalServerErrorException('Failed to create request');
    }

    const requesterName = requester
      ? `${requester.first_name} ${requester.last_name}`
      : 'Someone';

    this.notifications
      .create({
        user_id: book.donor_id,
        type: 'book_request',
        message: `${requesterName} requested your book "${book.title}"`,
        ref_id: saved.id,
        ref_type: 'book_request',
      })
      .catch(() => {});

    return {
      id: saved.id,
      book_id: saved.book_id,
      requester_id: saved.requester_id,
      message: saved.message,
      contact: saved.contact,
      status: saved.status,
    };
  }

  // ─── Accept a request (reveal contact, mark donated) ───────────────────────

  async accept(bookId: string, requestId: string, userId: string) {
    const book = await this.books.findOne({
      where: { id: bookId },
      select: {
        id: true,
        donor_id: true,
        status: true,
        title: true,
        contact: true,
      },
    });

    if (!book) throw new NotFoundException('Book not found');
    if (book.donor_id !== userId)
      throw new ForbiddenException('Only the donor can accept requests');

    const req = await this.requests.findOne({
      where: { id: requestId, book_id: bookId },
      select: { id: true, requester_id: true, status: true, contact: true },
    });

    if (!req) throw new NotFoundException('Request not found');
    if (req.status !== 'pending')
      throw new BadRequestException('Request is no longer pending');

    await this.requests.update(
      { id: requestId },
      { status: 'accepted', resolved_at: new Date() },
    );
    await this.books.update({ id: bookId }, { status: 'donated' });

    const contactLine = book.contact
      ? `Contact the donor: ${book.contact}`
      : 'The donor will reach out to you';

    this.notifications
      .create({
        user_id: req.requester_id,
        type: 'book_accepted',
        message: `Your request for "${book.title}" was accepted! ${contactLine}`,
        ref_id: requestId,
        ref_type: 'book_request',
      })
      .catch(() => {});

    return { message: 'Request accepted', contact: req.contact };
  }

  // ─── Decline a request ─────────────────────────────────────────────────────

  async decline(
    bookId: string,
    requestId: string,
    userId: string,
    reason?: string,
  ) {
    const book = await this.books.findOne({
      where: { id: bookId },
      select: { id: true, donor_id: true, title: true },
    });

    if (!book) throw new NotFoundException('Book not found');
    if (book.donor_id !== userId)
      throw new ForbiddenException('Only the donor can decline requests');

    const req = await this.requests.findOne({
      where: { id: requestId, book_id: bookId },
      select: { id: true, requester_id: true, status: true },
    });

    if (!req) throw new NotFoundException('Request not found');
    if (req.status !== 'pending')
      throw new BadRequestException('Request is no longer pending');

    await this.requests.update(
      { id: requestId },
      {
        status: 'declined',
        resolved_at: new Date(),
        decline_reason: reason ?? null,
      },
    );

    const declineMessage = reason
      ? `Your request for "${book.title}" was declined: ${reason}`
      : `Your request for "${book.title}" was declined`;

    this.notifications
      .create({
        user_id: req.requester_id,
        type: 'book_declined',
        message: declineMessage,
        ref_id: requestId,
        ref_type: 'book_request',
      })
      .catch(() => {});

    return { message: 'Request declined' };
  }

  // ─── Incoming requests on the donor's books (Dashboard) ────────────────────

  async getIncomingRequests(userId: string) {
    const myBooks = await this.books.find({
      where: { donor_id: userId },
      select: { id: true },
    });
    const myBookIds = myBooks.map((b) => b.id);
    if (myBookIds.length === 0) return [];

    let rows: BookRequest[];
    try {
      rows = await this.requests.find({
        where: { book_id: In(myBookIds) },
        relations: { book: true, requester: true },
        order: { requested_at: 'DESC' },
      });
    } catch {
      throw new InternalServerErrorException('Failed to fetch requests');
    }

    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      message: row.message,
      // Contact only revealed once the donor has accepted
      contact: row.status === 'accepted' ? row.contact : null,
      requested_at: row.requested_at,
      resolved_at: row.resolved_at,
      book: {
        id: row.book?.id,
        title: row.book?.title,
        cover_image_url: row.book?.cover_image_url,
      },
      requester: {
        id: row.requester?.id,
        first_name: row.requester?.first_name,
        last_name: row.requester?.last_name,
        avatar_url: row.requester?.avatar_url,
      },
    }));
  }

  // ─── Books I donated (with their active request, if any) ───────────────────

  async getMyBooks(
    userId: string,
    filter: 'all' | 'pending' | 'donated' = 'all',
  ) {
    // For the "pending requests" filter, narrow to the books that currently
    // have a pending incoming request — resolved in the DB, not the browser.
    let pendingBookIds: string[] | null = null;
    if (filter === 'pending') {
      const reqRows = await this.requests
        .createQueryBuilder('r')
        .innerJoin('r.book', 'b')
        .select('r.book_id', 'book_id')
        .where('r.status = :status', { status: 'pending' })
        .andWhere('b.donor_id = :userId', { userId })
        .getRawMany<{ book_id: string }>();
      pendingBookIds = [...new Set(reqRows.map((r) => r.book_id))];
      if (!pendingBookIds.length) return [];
    }

    let books: Book[];
    try {
      const qb = this.books
        .createQueryBuilder('b')
        .leftJoinAndSelect('b.major', 'major')
        .where('b.donor_id = :userId', { userId })
        .orderBy('b.created_at', 'DESC');
      if (filter === 'donated')
        qb.andWhere('b.status = :status', { status: 'donated' });
      if (pendingBookIds)
        qb.andWhere('b.id IN (:...pendingBookIds)', { pendingBookIds });
      books = await qb.getMany();
    } catch {
      throw new InternalServerErrorException('Failed to fetch your books');
    }

    const bookIds = books.map((b) => b.id);
    const reqByBook: Record<string, BookRequest> = {};
    if (bookIds.length) {
      const reqs = await this.requests.find({
        where: {
          book_id: In(bookIds),
          status: In(['pending', 'accepted']),
        },
        relations: { requester: true },
        order: { requested_at: 'DESC' },
      });
      for (const r of reqs) {
        // keep the most relevant active request per book (latest first)
        if (!reqByBook[r.book_id]) reqByBook[r.book_id] = r;
      }
    }

    return books.map((b) => {
      const r = reqByBook[b.id];
      return {
        id: b.id,
        title: b.title,
        description: b.description,
        contact: b.contact,
        cover_image_url: b.cover_image_url,
        status: b.status,
        created_at: b.created_at,
        majors: b.major ? { id: b.major.id, acronym: b.major.acronym } : null,
        request: r
          ? {
              id: r.id,
              status: r.status,
              message: r.message,
              contact: r.status === 'accepted' ? r.contact : null,
              requested_at: r.requested_at,
              requester: {
                id: r.requester?.id,
                first_name: r.requester?.first_name,
                last_name: r.requester?.last_name,
                avatar_url: r.requester?.avatar_url,
              },
            }
          : null,
      };
    });
  }

  // ─── Dashboard counts (cheap COUNT queries, no rows fetched) ───────────────

  async getBookStats(userId: string) {
    const [listed, received, pendingIncoming] = await Promise.all([
      this.books.count({ where: { donor_id: userId } }),
      this.requests.count({
        where: { requester_id: userId, status: 'accepted' },
      }),
      this.requests
        .createQueryBuilder('r')
        .innerJoin('r.book', 'b')
        .where('r.status = :status', { status: 'pending' })
        .andWhere('b.donor_id = :userId', { userId })
        .getCount(),
    ]);

    return { listed, received, pendingIncoming };
  }

  // ─── Books I requested (outgoing requests) ─────────────────────────────────

  async getOutgoingRequests(
    userId: string,
    status?: 'pending' | 'accepted' | 'declined',
  ) {
    let rows: BookRequest[];
    try {
      const qb = this.requests
        .createQueryBuilder('r')
        .leftJoinAndSelect('r.book', 'book')
        .leftJoinAndSelect('book.donor', 'donor')
        .where('r.requester_id = :userId', { userId })
        .orderBy('r.requested_at', 'DESC');
      if (status) qb.andWhere('r.status = :status', { status });
      rows = await qb.getMany();
    } catch {
      throw new InternalServerErrorException('Failed to fetch your requests');
    }

    return rows.map((row) => {
      const book = row.book;
      const donor = book?.donor;
      return {
        id: row.id,
        status: row.status,
        requested_at: row.requested_at,
        // Donor's contact revealed to the requester once accepted
        contact: row.status === 'accepted' ? book?.contact : null,
        book: {
          id: book?.id,
          title: book?.title,
          cover_image_url: book?.cover_image_url,
        },
        donor: {
          id: donor?.id,
          first_name: donor?.first_name,
          last_name: donor?.last_name,
          avatar_url: donor?.avatar_url,
        },
      };
    });
  }

  // ─── Single request detail (notification detail page) ──────────────────────

  async getRequestDetail(requestId: string, userId: string) {
    let row: BookRequest | null;
    try {
      row = await this.requests.findOne({
        where: { id: requestId },
        relations: { book: { donor: true }, requester: true },
      });
    } catch (err) {
      throw new InternalServerErrorException(String(err));
    }
    if (!row) throw new NotFoundException('Request not found');

    const book = row.book;
    const requester = row.requester;
    const donor = book?.donor;
    const isDonor = book?.donor_id === userId;
    const isRequester = requester?.id === userId;
    if (!isDonor && !isRequester)
      throw new ForbiddenException('Not your request');

    const accepted = row.status === 'accepted';

    return {
      id: row.id,
      role: isDonor ? 'donor' : 'requester',
      status: row.status,
      message: row.message,
      requested_at: row.requested_at,
      resolved_at: row.resolved_at,
      decline_reason: row.decline_reason,
      book: {
        id: book?.id,
        title: book?.title,
        cover_image_url: book?.cover_image_url,
      },
      requester: {
        id: requester?.id,
        first_name: requester?.first_name,
        last_name: requester?.last_name,
        avatar_url: requester?.avatar_url,
      },
      donor: {
        id: donor?.id ?? book?.donor_id,
        first_name: donor?.first_name,
        last_name: donor?.last_name,
        avatar_url: donor?.avatar_url,
      },
      // The contact the viewer needs, revealed only once accepted:
      // donor sees the requester's contact, requester sees the donor's contact
      contact: accepted ? (isDonor ? row.contact : book?.contact) : null,
    };
  }

  // ─── Upload cover image ────────────────────────────────────────────────────

  async uploadCover(userId: string, file: Express.Multer.File) {
    const ext = file.originalname.split('.').pop();
    const key = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    try {
      const url = await this.storage.upload(
        BUCKETS.BOOK_COVERS,
        key,
        file.buffer,
        file.mimetype,
      );
      return { url };
    } catch {
      throw new InternalServerErrorException('Cover image upload failed');
    }
  }
}
