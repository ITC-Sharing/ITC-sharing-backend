import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateBookDto } from './dto/create-book.dto';
import { UpdateBookDto } from './dto/update-book.dto';
import { CreateRequestDto } from './dto/create-request.dto';

const COVER_BUCKET = 'book-covers';

const BOOK_SELECT = `
  id, title, description, contact, status, cover_image_url, created_at,
  majors ( id, acronym ),
  users!books_donor_id_fkey ( id, first_name, last_name, avatar_url )
`;

const REQUEST_SELECT = `
  id, message, contact, status, requested_at, resolved_at,
  books ( id, title, cover_image_url, donor_id ),
  users ( id, first_name, last_name, avatar_url )
`;

@Injectable()
export class BooksService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly notifications: NotificationsService,
  ) {}

  // ─── Donate (list) a book ──────────────────────────────────────────────────

  async donate(donorId: string, dto: CreateBookDto) {
    const { data, error } = await this.supabase
      .getClient()
      .from('books')
      .insert({
        donor_id: donorId,
        major_id: dto.department,
        title: dto.title,
        description: dto.description ?? null,
        contact: dto.contact ?? null,
        cover_image_url: dto.cover_image_url ?? null,
        status: 'available',
      })
      .select(BOOK_SELECT)
      .single();

    if (error) {
      if (error.code === '23503')
        throw new BadRequestException('Invalid department');
      throw new InternalServerErrorException('Failed to list book');
    }

    return data;
  }

  // ─── List available books ──────────────────────────────────────────────────

  async findAll(majorId?: string) {
    const client = this.supabase.getClient();

    let query = client
      .from('books')
      .select(BOOK_SELECT)
      .eq('status', 'available')
      .order('created_at', { ascending: false });

    if (majorId) query = query.eq('major_id', majorId);

    const { data, error } = await query;
    if (error) throw new InternalServerErrorException('Failed to fetch books');

    const bookIds = (data ?? []).map((b: any) => b.id);
    const activeBookIds = new Set<string>();
    if (bookIds.length) {
      const { data: activeRequests } = await client
        .from('book_requests')
        .select('book_id')
        .in('book_id', bookIds)
        .in('status', ['pending', 'accepted']);
      for (const r of activeRequests ?? []) activeBookIds.add(r.book_id);
    }

    return (data ?? []).map((b: any) => ({
      ...b,
      has_active_request: activeBookIds.has(b.id),
    }));
  }

  // ─── Get single book ───────────────────────────────────────────────────────

  async findOne(id: string) {
    const client = this.supabase.getClient();

    const { data, error } = await client
      .from('books')
      .select(BOOK_SELECT)
      .eq('id', id)
      .single();

    if (error || !data) throw new NotFoundException('Book not found');

    const { data: activeRequest } = await client
      .from('book_requests')
      .select('id')
      .eq('book_id', id)
      .in('status', ['pending', 'accepted'])
      .maybeSingle();

    return { ...data, has_active_request: !!activeRequest };
  }

  // ─── Update own book ───────────────────────────────────────────────────────

  async update(id: string, userId: string, dto: UpdateBookDto) {
    const client = this.supabase.getClient();

    const { data: book } = await client
      .from('books')
      .select('id, donor_id, status')
      .eq('id', id)
      .single();

    if (!book) throw new NotFoundException('Book not found');
    if (book.donor_id !== userId) throw new ForbiddenException('Not your book');
    if (book.status !== 'available')
      throw new BadRequestException('Only available books can be edited');

    const { department, ...rest } = dto;
    const { data, error } = await client
      .from('books')
      .update({ ...rest, ...(department && { major_id: department }) })
      .eq('id', id)
      .select(BOOK_SELECT)
      .single();

    if (error) throw new InternalServerErrorException('Failed to update book');
    return data;
  }

  // ─── Delete own book ───────────────────────────────────────────────────────

  async remove(id: string, userId: string) {
    const client = this.supabase.getClient();

    const { data: book } = await client
      .from('books')
      .select('id, donor_id, status')
      .eq('id', id)
      .single();

    if (!book) throw new NotFoundException('Book not found');
    if (book.donor_id !== userId) throw new ForbiddenException('Not your book');
    if (book.status === 'donated')
      throw new BadRequestException('Donated books cannot be deleted');

    // Remove notifications that point to this book's requests — once the book
    // (and its requests, via cascade) is deleted they'd become dead links that
    // 404 when a recipient opens them.
    const { data: reqs } = await client
      .from('book_requests')
      .select('id')
      .eq('book_id', id);
    const reqIds = (reqs ?? []).map((r: any) => r.id);
    if (reqIds.length) {
      await client
        .from('notifications')
        .delete()
        .eq('ref_type', 'book_request')
        .in('ref_id', reqIds);
    }

    const { error } = await client.from('books').delete().eq('id', id);
    if (error) throw new InternalServerErrorException('Failed to delete book');

    return { message: 'Book deleted' };
  }

  // ─── Request a book ────────────────────────────────────────────────────────

  async request(bookId: string, requesterId: string, dto: CreateRequestDto) {
    const client = this.supabase.getClient();

    const { data: book } = await client
      .from('books')
      .select('id, donor_id, status, title')
      .eq('id', bookId)
      .single();

    if (!book) throw new NotFoundException('Book not found');
    if (book.status !== 'available')
      throw new BadRequestException('Book is not available');
    if (book.donor_id === requesterId)
      throw new ForbiddenException('You cannot request your own book');

    const { data: existing } = await client
      .from('book_requests')
      .select('id')
      .eq('book_id', bookId)
      .in('status', ['pending', 'accepted'])
      .maybeSingle();

    if (existing)
      throw new BadRequestException('This book already has an active request');

    const { data: requester } = await client
      .from('users')
      .select('first_name, last_name')
      .eq('id', requesterId)
      .single();

    const { data, error } = await client
      .from('book_requests')
      .insert({
        book_id: bookId,
        requester_id: requesterId,
        message: dto.message ?? null,
        contact: dto.contact,
        status: 'pending',
      })
      .select('id, book_id, requester_id, message, contact, status')
      .single();

    if (error)
      throw new InternalServerErrorException('Failed to create request');

    const requesterName = requester
      ? `${requester.first_name} ${requester.last_name}`
      : 'Someone';

    this.notifications
      .create({
        user_id: book.donor_id,
        type: 'book_request',
        message: `${requesterName} requested your book "${book.title}"`,
        ref_id: data.id,
        ref_type: 'book_request',
      })
      .catch(() => {});

    return data;
  }

  // ─── Accept a request (reveal contact, mark donated) ───────────────────────

  async accept(bookId: string, requestId: string, userId: string) {
    const client = this.supabase.getClient();

    const { data: book } = await client
      .from('books')
      .select('id, donor_id, status, title, contact')
      .eq('id', bookId)
      .single();

    if (!book) throw new NotFoundException('Book not found');
    if (book.donor_id !== userId)
      throw new ForbiddenException('Only the donor can accept requests');

    const { data: req } = await client
      .from('book_requests')
      .select('id, requester_id, status, contact')
      .eq('id', requestId)
      .eq('book_id', bookId)
      .single();

    if (!req) throw new NotFoundException('Request not found');
    if (req.status !== 'pending')
      throw new BadRequestException('Request is no longer pending');

    await client
      .from('book_requests')
      .update({ status: 'accepted', resolved_at: new Date().toISOString() })
      .eq('id', requestId);
    await client.from('books').update({ status: 'donated' }).eq('id', bookId);

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

  async decline(bookId: string, requestId: string, userId: string, reason?: string) {
    const client = this.supabase.getClient();

    const { data: book } = await client
      .from('books')
      .select('id, donor_id, title')
      .eq('id', bookId)
      .single();

    if (!book) throw new NotFoundException('Book not found');
    if (book.donor_id !== userId)
      throw new ForbiddenException('Only the donor can decline requests');

    const { data: req } = await client
      .from('book_requests')
      .select('id, requester_id, status')
      .eq('id', requestId)
      .eq('book_id', bookId)
      .single();

    if (!req) throw new NotFoundException('Request not found');
    if (req.status !== 'pending')
      throw new BadRequestException('Request is no longer pending');

    await client
      .from('book_requests')
      .update({
        status: 'declined',
        resolved_at: new Date().toISOString(),
        decline_reason: reason ?? null,
      })
      .eq('id', requestId);

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
    const client = this.supabase.getClient();

    const { data: myBooks } = await client
      .from('books')
      .select('id')
      .eq('donor_id', userId);
    const myBookIds = myBooks?.map((b: any) => b.id) ?? [];
    if (myBookIds.length === 0) return [];

    const { data, error } = await client
      .from('book_requests')
      .select(REQUEST_SELECT)
      .in('book_id', myBookIds)
      .order('requested_at', { ascending: false });

    if (error)
      throw new InternalServerErrorException('Failed to fetch requests');

    return (data ?? []).map((row: any) => ({
      id: row.id,
      status: row.status,
      message: row.message,
      // Contact only revealed once the donor has accepted
      contact: row.status === 'accepted' ? row.contact : null,
      requested_at: row.requested_at,
      resolved_at: row.resolved_at,
      book: {
        id: row.books?.id,
        title: row.books?.title,
        cover_image_url: row.books?.cover_image_url,
      },
      requester: {
        id: row.users?.id,
        first_name: row.users?.first_name,
        last_name: row.users?.last_name,
        avatar_url: row.users?.avatar_url,
      },
    }));
  }

  // ─── Books I donated (with their active request, if any) ───────────────────

  async getMyBooks(userId: string, filter: 'all' | 'pending' | 'donated' = 'all') {
    const client = this.supabase.getClient();

    // For the "pending requests" filter, narrow to the books that currently
    // have a pending incoming request — resolved in the DB, not the browser.
    let pendingBookIds: string[] | null = null;
    if (filter === 'pending') {
      const { data: reqRows } = await client
        .from('book_requests')
        .select('book_id, books!inner(donor_id)')
        .eq('status', 'pending')
        .eq('books.donor_id', userId);
      pendingBookIds = [...new Set((reqRows ?? []).map((r: any) => r.book_id))];
      if (!pendingBookIds.length) return [];
    }

    let query = client
      .from('books')
      .select(
        'id, title, description, contact, cover_image_url, status, created_at, majors ( id, acronym )',
      )
      .eq('donor_id', userId)
      .order('created_at', { ascending: false });

    if (filter === 'donated') query = query.eq('status', 'donated');
    if (pendingBookIds) query = query.in('id', pendingBookIds);

    const { data: books, error } = await query;

    if (error) throw new InternalServerErrorException('Failed to fetch your books');

    const bookIds = (books ?? []).map((b: any) => b.id);
    const reqByBook: Record<string, any> = {};
    if (bookIds.length) {
      const { data: reqs } = await client
        .from('book_requests')
        .select(
          'id, book_id, status, message, contact, requested_at, users ( id, first_name, last_name, avatar_url )',
        )
        .in('book_id', bookIds)
        .in('status', ['pending', 'accepted'])
        .order('requested_at', { ascending: false });

      for (const r of reqs ?? []) {
        // keep the most relevant active request per book (latest first)
        if (!reqByBook[r.book_id]) reqByBook[r.book_id] = r;
      }
    }

    return (books ?? []).map((b: any) => {
      const r = reqByBook[b.id];
      return {
        id: b.id,
        title: b.title,
        description: b.description,
        contact: b.contact,
        cover_image_url: b.cover_image_url,
        status: b.status,
        created_at: b.created_at,
        majors: b.majors,
        request: r
          ? {
              id: r.id,
              status: r.status,
              message: r.message,
              contact: r.status === 'accepted' ? r.contact : null,
              requested_at: r.requested_at,
              requester: {
                id: r.users?.id,
                first_name: r.users?.first_name,
                last_name: r.users?.last_name,
                avatar_url: r.users?.avatar_url,
              },
            }
          : null,
      };
    });
  }

  // ─── Dashboard counts (cheap COUNT queries, no rows fetched) ───────────────

  async getBookStats(userId: string) {
    const client = this.supabase.getClient();

    const [listedRes, receivedRes, pendingIncomingRes] = await Promise.all([
      client
        .from('books')
        .select('id', { count: 'exact', head: true })
        .eq('donor_id', userId),
      client
        .from('book_requests')
        .select('id', { count: 'exact', head: true })
        .eq('requester_id', userId)
        .eq('status', 'accepted'),
      client
        .from('book_requests')
        .select('id, books!inner(donor_id)', { count: 'exact', head: true })
        .eq('status', 'pending')
        .eq('books.donor_id', userId),
    ]);

    return {
      listed: listedRes.count ?? 0,
      received: receivedRes.count ?? 0,
      pendingIncoming: pendingIncomingRes.count ?? 0,
    };
  }

  // ─── Books I requested (outgoing requests) ─────────────────────────────────

  async getOutgoingRequests(
    userId: string,
    status?: 'pending' | 'accepted' | 'declined',
  ) {
    const client = this.supabase.getClient();

    let query = client
      .from('book_requests')
      .select(
        `
        id, status, requested_at, resolved_at,
        books (
          id, title, cover_image_url, contact,
          users!books_donor_id_fkey ( id, first_name, last_name, avatar_url )
        )
      `,
      )
      .eq('requester_id', userId)
      .order('requested_at', { ascending: false });

    if (status) query = query.eq('status', status);

    const { data, error } = await query;

    if (error) throw new InternalServerErrorException('Failed to fetch your requests');

    return (data ?? []).map((row: any) => {
      const book = row.books ?? {};
      const donor = book.users ?? {};
      return {
        id: row.id,
        status: row.status,
        requested_at: row.requested_at,
        // Donor's contact revealed to the requester once accepted
        contact: row.status === 'accepted' ? book.contact : null,
        book: {
          id: book.id,
          title: book.title,
          cover_image_url: book.cover_image_url,
        },
        donor: {
          id: donor.id,
          first_name: donor.first_name,
          last_name: donor.last_name,
          avatar_url: donor.avatar_url,
        },
      };
    });
  }

  // ─── Single request detail (notification detail page) ──────────────────────

  async getRequestDetail(requestId: string, userId: string) {
    const client = this.supabase.getClient();

    const { data: row, error } = await client
      .from('book_requests')
      .select(`
        id, message, contact, status, requested_at, resolved_at, decline_reason,
        books (
          id, title, cover_image_url, donor_id, contact,
          users!books_donor_id_fkey ( id, first_name, last_name, avatar_url )
        ),
        users ( id, first_name, last_name, avatar_url )
      `)
      .eq('id', requestId)
      .maybeSingle();

    // Don't swallow query failures (e.g. a missing column) as a "not found".
    if (error) throw new InternalServerErrorException(error.message);
    if (!row) throw new NotFoundException('Request not found');

    const book: any = row.books ?? {};
    const requester: any = row.users ?? {};
    const donor: any = book.users ?? {};
    const isDonor = book.donor_id === userId;
    const isRequester = requester.id === userId;
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
        id: book.id,
        title: book.title,
        cover_image_url: book.cover_image_url,
      },
      requester: {
        id: requester.id,
        first_name: requester.first_name,
        last_name: requester.last_name,
        avatar_url: requester.avatar_url,
      },
      donor: {
        id: donor.id ?? book.donor_id,
        first_name: donor.first_name,
        last_name: donor.last_name,
        avatar_url: donor.avatar_url,
      },
      // The contact the viewer needs, revealed only once accepted:
      // donor sees the requester's contact, requester sees the donor's contact
      contact: accepted ? (isDonor ? row.contact : book.contact) : null,
    };
  }

  // ─── Upload cover image ────────────────────────────────────────────────────

  async uploadCover(userId: string, file: Express.Multer.File) {
    const ext = file.originalname.split('.').pop();
    const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const { error } = await this.supabase
      .getClient()
      .storage.from(COVER_BUCKET)
      .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });

    if (error) throw new InternalServerErrorException('Cover image upload failed');

    const { data } = this.supabase
      .getClient()
      .storage.from(COVER_BUCKET)
      .getPublicUrl(path);

    return { url: data.publicUrl };
  }
}
