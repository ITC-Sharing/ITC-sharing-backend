import {
  Injectable,
  InternalServerErrorException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Upload } from '../documents/entities/upload.entity';
import { DocumentFile } from '../documents/entities/document.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { Book } from '../books/entities/book.entity';
import { BookRequest } from '../books/entities/book-request.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { Major } from '../majors/entities/major.entity';
import { yearLevelsForMajor } from '../documents/utils/year-levels';
import { StorageService } from '../storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ModerationService, Reviewer } from './moderation.service';
import { PromotionSettingsService } from '../settings/promotion-settings.service';

const SUBJECT_STATUSES = ['active', 'pending', 'rejected'];
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(Upload)
    private readonly uploads: Repository<Upload>,
    @InjectRepository(DocumentFile)
    private readonly documents: Repository<DocumentFile>,
    @InjectRepository(Subject)
    private readonly subjects: Repository<Subject>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
    @InjectRepository(Book)
    private readonly books: Repository<Book>,
    @InjectRepository(Major)
    private readonly majors: Repository<Major>,
    @InjectRepository(BookRequest)
    private readonly bookRequests: Repository<BookRequest>,
    @InjectRepository(Notification)
    private readonly notificationsRepo: Repository<Notification>,
    private readonly storage: StorageService,
    private readonly notificationsService: NotificationsService,
    private readonly moderation: ModerationService,
    private readonly promotionSettings: PromotionSettingsService,
  ) {}

  /**
   * Filter values arrive straight from the query string, so a malformed id would
   * otherwise reach Postgres and surface as a 500 instead of a 400.
   */
  private assertUuid(value: string, field: string) {
    if (!UUID_PATTERN.test(value))
      throw new BadRequestException(`${field} must be a valid UUID`);
    return value;
  }

  // ─── Stats ─────────────────────────────────────────────────────────────────

  async getStats() {
    const [totalUsers, totalDocuments, totalSubjects, totalBooks] =
      await Promise.all([
        this.users.count(),
        this.uploads.count({ where: { status: 'active' } }),
        this.subjects.count({ where: { status: 'active' } }),
        this.books.count(),
      ]);

    return {
      totalUsers,
      totalDocuments,
      totalSubjects,
      totalBooks,
      uploadsByMonth: await this.uploadsByMonth(),
    };
  }

  /**
   * Approved uploads per month for the last 6 months, oldest first.
   *
   * generate_series supplies the months, so a month with no uploads comes back
   * as 0 rather than being missing — a chart that skipped empty months would
   * imply activity that never happened.
   */
  private async uploadsByMonth(months = 6) {
    const rows: { month: string; count: string }[] = await this.uploads.query(
      `
      with span as (
        select generate_series(
          date_trunc('month', now()) - make_interval(months => $1::int - 1),
          date_trunc('month', now()),
          interval '1 month'
        ) as month
      )
      select to_char(span.month, 'YYYY-MM') as month,
             count(u.id)                   as count
        from span
   left join uploads u
          on date_trunc('month', u.uploaded_at) = span.month
         and u.status = 'active'
    group by span.month
    order by span.month
      `,
      [months],
    );

    return rows.map((r) => ({ month: r.month, count: Number(r.count) }));
  }

  // ─── Recent uploads ────────────────────────────────────────────────────────

  async getRecentDocuments(limit = 10) {
    let rows: Upload[];
    try {
      rows = await this.uploads.find({
        where: { status: 'active' },
        relations: {
          uploader: true,
          major: true,
          subject: true,
          documents: true,
        },
        order: { uploaded_at: 'DESC' },
        take: limit,
      });
    } catch {
      throw new InternalServerErrorException(
        'Failed to fetch recent documents',
      );
    }

    return rows.map((u) => ({
      id: u.id,
      title: u.title,
      doc_type: u.doc_type,
      uploaded_at: u.uploaded_at,
      users: u.uploader
        ? {
            id: u.uploader.id,
            first_name: u.uploader.first_name,
            last_name: u.uploader.last_name,
          }
        : null,
      majors: u.major ? { id: u.major.id, acronym: u.major.acronym } : null,
      subjects: u.subject ? { id: u.subject.id, name: u.subject.name } : null,
      documents: (u.documents ?? []).map((d) => ({
        file_size_kb: d.file_size_kb,
      })),
    }));
  }

  // ─── Users ─────────────────────────────────────────────────────────────────

  async getAllUsers(search?: string) {
    const qb = this.users
      .createQueryBuilder('u')
      .leftJoinAndSelect('u.major', 'major')
      .orderBy('u.created_at', 'DESC');

    if (search) {
      qb.where(
        '(u.first_name ILIKE :s OR u.last_name ILIKE :s OR u.email ILIKE :s)',
        { s: `%${search}%` },
      );
    }

    let rows: User[];
    try {
      rows = await qb.getMany();
    } catch {
      throw new InternalServerErrorException('Failed to fetch users');
    }

    // One query for every assignment, rather than one per user.
    const moderatedBy = await this.moderation.assignmentsByUser(
      rows.map((u) => u.id),
    );

    return rows.map((u) => ({
      id: u.id,
      first_name: u.first_name,
      last_name: u.last_name,
      email: u.email,
      role: u.role,
      year_level: u.year_level,
      created_at: u.created_at,
      majors: u.major ? { id: u.major.id, acronym: u.major.acronym } : null,
      // Everything the admin UI needs to show state and offer the right action.
      banned_at: u.banned_at,
      ban_reason: u.ban_reason,
      moderates: moderatedBy.get(u.id) ?? [],
    }));
  }

  // ─── All documents (admin table view) ─────────────────────────────────────

  async getAllDocuments(filters: {
    search?: string;
    docType?: string;
    majorId?: string;
    uploaderId?: string;
    /** ISO timestamp; only uploads at or after it are returned. */
    since?: string;
  }) {
    const { search, docType, majorId, uploaderId, since } = filters;
    const qb = this.uploads
      .createQueryBuilder('u')
      .leftJoinAndSelect('u.uploader', 'uploader')
      .leftJoinAndSelect('u.major', 'major')
      .leftJoinAndSelect('u.subject', 'subject')
      .leftJoinAndSelect('u.documents', 'documents')
      .where('u.status = :status', { status: 'active' })
      .orderBy('u.uploaded_at', 'DESC');

    if (search)
      qb.andWhere('(u.title ILIKE :search OR u.description ILIKE :search)', {
        search: `%${search}%`,
      });
    if (docType) qb.andWhere('u.doc_type = :docType', { docType });
    if (majorId)
      qb.andWhere('u.major_id = :majorId', {
        majorId: this.assertUuid(majorId, 'major_id'),
      });
    if (uploaderId)
      qb.andWhere('u.uploader_id = :uploaderId', {
        uploaderId: this.assertUuid(uploaderId, 'uploader_id'),
      });
    if (since) {
      const from = new Date(since);
      if (Number.isNaN(from.getTime()))
        throw new BadRequestException('since must be an ISO date');
      qb.andWhere('u.uploaded_at >= :since', { since: from });
    }

    let rows: Upload[];
    try {
      rows = await qb.getMany();
    } catch {
      throw new InternalServerErrorException('Failed to fetch documents');
    }

    // Signed here, not returned raw: the `documents` bucket is private, so the
    // stored URL would 403 in the admin table. Same treatment as every other
    // list — see signRef.
    return Promise.all(
      rows.map(async (u) => ({
        id: u.id,
        title: u.title,
        doc_type: u.doc_type,
        uploaded_at: u.uploaded_at,
        users: u.uploader
          ? {
              id: u.uploader.id,
              first_name: u.uploader.first_name,
              last_name: u.uploader.last_name,
            }
          : null,
        majors: u.major ? { id: u.major.id, acronym: u.major.acronym } : null,
        /** The cohort the upload is for; the table shows it as "I3-GIC". */
        year_level: u.year_level,
        subjects: u.subject ? { id: u.subject.id, name: u.subject.name } : null,
        description: u.description,
        documents: await Promise.all(
          (u.documents ?? []).map(async (d) => ({
            id: d.id,
            file_url: await this.signRef(
              d.storage_key,
              d.file_url,
              d.original_name,
            ),
            original_name: d.original_name,
            file_size_kb: d.file_size_kb,
            // The expanded row previews office files through their PDF
            // rendition — ours, so it may render in place.
            preview_url: await this.signRef(
              d.preview_key,
              d.preview_url,
              d.original_name,
              true,
            ),
          })),
        ),
      })),
    );
  }

  // ─── User administration ───────────────────────────────────────────────────

  /**
   * Promote to admin or demote back to a normal user.
   *
   * Moderator is NOT a role — it's an assignment per department (see
   * ModerationService), so promoting someone to review GIC doesn't touch this.
   *
   * Two self-inflicted lockouts are refused: demoting yourself, and demoting the
   * last admin. Either would leave nobody able to promote anyone back.
   */
  // ─── Books (admin only) ──────────────────────────────────────────────────
  // Books are never reviewed — a donation goes live immediately. Admins get
  // this listing to correct a status or take a listing down, not to approve.

  /**
   * Every book, newest first, with its donor and whether a request is open.
   *
   * `open_requests` matters because "requesting" is not a stored status: a book
   * someone has asked for is still 'available' in the row, and the count is the
   * only way to see it here.
   */
  async getAllBooks(search?: string) {
    const qb = this.books
      .createQueryBuilder('b')
      .leftJoinAndSelect('b.donor', 'donor')
      .leftJoinAndSelect('b.major', 'major')
      .orderBy('b.created_at', 'DESC');

    if (search?.trim()) {
      qb.where(
        '(b.title ILIKE :q OR donor.first_name ILIKE :q OR donor.last_name ILIKE :q OR donor.email ILIKE :q)',
        { q: `%${search.trim()}%` },
      );
    }

    const books = await qb.getMany();
    if (!books.length) return [];

    const open = await this.bookRequests
      .createQueryBuilder('r')
      .select('r.book_id', 'book_id')
      .addSelect('count(*)', 'count')
      .where('r.book_id IN (:...ids)', { ids: books.map((b) => b.id) })
      .andWhere('r.status IN (:...statuses)', {
        statuses: ['pending', 'accepted'],
      })
      .groupBy('r.book_id')
      .getRawMany<{ book_id: string; count: string }>();

    const openByBook = new Map(open.map((r) => [r.book_id, Number(r.count)]));

    return books.map((b) => ({
      id: b.id,
      title: b.title,
      status: b.status,
      hidden_at: b.hidden_at,
      cover_image_url: b.cover_image_url,
      created_at: b.created_at,
      open_requests: openByBook.get(b.id) ?? 0,
      major: b.major ? { id: b.major.id, acronym: b.major.acronym } : null,
      donor: b.donor
        ? {
            id: b.donor.id,
            first_name: b.donor.first_name,
            last_name: b.donor.last_name,
            email: b.donor.email,
          }
        : null,
    }));
  }

  /**
   * Take a listing out of circulation, or put it back.
   *
   * The row is untouched otherwise: the donor keeps seeing it in "My books"
   * (marked hidden), so their book does not silently vanish, but it is gone
   * from the public list and its detail page 404s.
   */
  async setBookHidden(bookId: string, hidden: boolean) {
    const book = await this.books.findOne({
      where: { id: bookId },
      select: { id: true },
    });
    if (!book) throw new NotFoundException('Book not found');

    await this.books.update(
      { id: bookId },
      { hidden_at: hidden ? new Date() : null },
    );
    return { message: hidden ? 'Book hidden' : 'Book visible', hidden };
  }

  /**
   * Remove a book outright.
   *
   * Unlike the donor's own delete, this is not blocked by an open request or by
   * the book already being donated — it exists precisely for the listings a
   * donor cannot clean up themselves.
   */
  async deleteBook(bookId: string) {
    const book = await this.books.findOne({
      where: { id: bookId },
      select: { id: true, cover_image_url: true },
    });
    if (!book) throw new NotFoundException('Book not found');

    // Requests cascade with the book, but notifications pointing at them do
    // not — left behind they become links that 404 when a recipient opens them.
    const reqs = await this.bookRequests.find({
      where: { book_id: bookId },
      select: { id: true },
    });
    if (reqs.length) {
      await this.notificationsRepo.delete({
        ref_type: 'book_request',
        ref_id: In(reqs.map((r) => r.id)),
      });
    }

    const key = this.storage.extractKey(book.cover_image_url);
    if (key) await this.storage.remove([key]);

    try {
      await this.books.delete({ id: bookId });
    } catch {
      throw new InternalServerErrorException('Failed to delete book');
    }

    return { message: 'Book deleted' };
  }

  async setUserRole(targetId: string, role: 'user' | 'admin', actorId: string) {
    if (targetId === actorId && role !== 'admin') {
      throw new BadRequestException('You cannot demote yourself');
    }

    const target = await this.users.findOne({
      where: { id: targetId },
      select: { id: true, role: true, first_name: true, last_name: true },
    });
    if (!target) throw new NotFoundException('User not found');

    if (target.role === 'admin' && role !== 'admin') {
      const admins = await this.users.count({ where: { role: 'admin' } });
      if (admins <= 1) {
        throw new BadRequestException('The last admin cannot be demoted');
      }
    }

    await this.users.update({ id: targetId }, { role });

    void this.notificationsService.create({
      user_id: targetId,
      type: role === 'admin' ? 'role_promoted' : 'role_changed',
      message:
        role === 'admin'
          ? 'You are now an administrator.'
          : 'Your administrator access has been removed.',
      key: role === 'admin' ? 'roleAdminGranted' : 'roleAdminRemoved',
      ref_id: targetId,
      ref_type: 'user',
    });

    return { message: `Role updated to ${role}` };
  }

  /**
   * Ban an account: block sign-in and cut existing sessions.
   *
   * The row is kept — their uploads and history stay intact, and unbanning is a
   * single field. Refresh tokens are deleted so an open browser can't renew its
   * access token; the JWT strategy rejects the current one on its next request.
   */
  async banUser(targetId: string, actorId: string, reason?: string) {
    if (targetId === actorId) {
      throw new BadRequestException('You cannot ban yourself');
    }

    const target = await this.users.findOne({
      where: { id: targetId },
      select: { id: true, role: true, banned_at: true },
    });
    if (!target) throw new NotFoundException('User not found');
    if (target.role === 'admin') {
      // Demote first — deliberately two steps, so banning can't be used to take
      // another admin out in one move.
      throw new BadRequestException('Demote this admin before banning');
    }

    await this.users.update(
      { id: targetId },
      {
        banned_at: new Date(),
        ban_reason: reason?.trim() || null,
        banned_by: actorId,
      },
    );

    // Without this, a stored refresh token would mint new access tokens.
    await this.refreshTokens.delete({ user_id: targetId });
    // A banned reviewer shouldn't keep a review queue.
    await this.moderation.unassignAll(targetId);

    return { message: 'User banned' };
  }

  /**
   * Correct a student's department and year.
   *
   * Admin-only by design: the pair decides which documents they can see, so
   * PATCH /users/me refuses it once a profile is set. Placement is the
   * institute's call, and this is where a mistake gets fixed.
   *
   * Also settles any pending rollover — an admin placing someone into a
   * department has answered the question the prompt would ask.
   */
  async setUserPlacement(targetId: string, majorId: string, yearLevel: number) {
    const target = await this.users.findOne({
      where: { id: targetId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException('User not found');

    const major = await this.majors.findOne({ where: { id: majorId } });
    if (!major) throw new BadRequestException('Unknown department');

    // A GIC year 1 or a TC year 4 matches no upload's audience, so the student
    // would silently see nothing. Reject rather than store it.
    const allowed = yearLevelsForMajor(major.acronym);
    if (!allowed.includes(yearLevel))
      throw new BadRequestException(
        `${major.acronym} has years ${allowed.join(', ')} — not ${yearLevel}`,
      );

    await this.users.update(
      { id: targetId },
      {
        major_id: majorId,
        year_level: yearLevel,
        // An admin has just said where this student sits, so they are not owed
        // the current rollover — stamping it stops them being advanced again on
        // their next visit.
        promoted_rollover_at: await this.promotionSettings.rolloverAt(),
      },
    );

    void this.notificationsService.create({
      user_id: targetId,
      type: 'placement_changed',
      message: `Your academic placement has been updated to ${major.acronym}, Year ${yearLevel}.`,
      key: 'placementChanged',
      params: { acronym: major.acronym, year: yearLevel },
      ref_id: targetId,
      ref_type: 'user',
    });

    return {
      message: 'Placement updated',
      major_id: majorId,
      year_level: yearLevel,
    };
  }

  async unbanUser(targetId: string) {
    const target = await this.users.findOne({
      where: { id: targetId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException('User not found');

    await this.users.update(
      { id: targetId },
      { banned_at: null, ban_reason: null, banned_by: null },
    );

    void this.notificationsService.create({
      user_id: targetId,
      type: 'account_unbanned',
      message:
        'Your account has been reinstated. You can now access your account again.',
      key: 'accountReinstated',
      ref_id: targetId,
      ref_type: 'user',
    });

    return { message: 'User unbanned' };
  }

  // ─── Subjects ──────────────────────────────────────────────────────────────

  /**
   * The departments this reviewer answers for — what the review screen names in
   * its header, so a moderator can see the scope their queue is filtered to.
   *
   * `null` majors for an admin: they review everything, which is not the same
   * as reviewing an empty list, and the two must stay distinguishable (see
   * scopeMajorIds).
   */
  async getReviewerScope(reviewer: Reviewer) {
    const ids = this.moderation.scopeMajorIds(reviewer);
    if (ids === null) return { is_admin: true, majors: null };
    if (!ids.length) return { is_admin: false, majors: [] };

    const majors = await this.majors.find({
      where: { id: In(ids) },
      select: { id: true, acronym: true, name: true },
      order: { acronym: 'ASC' },
    });
    return { is_admin: false, majors };
  }

  async getPendingSubjects(reviewer: Reviewer) {
    // null = admin, no limit. [] = moderates nothing, so the queue is empty —
    // an unscoped query here would show every department's submissions.
    const scope = this.moderation.scopeMajorIds(reviewer);
    if (scope?.length === 0) return [];

    let rows: Subject[];
    try {
      const qb = this.subjects
        .createQueryBuilder('s')
        .leftJoinAndSelect('s.major', 'major')
        .leftJoinAndSelect('s.submitter', 'submitter')
        .where('s.status = :status', { status: 'pending' })
        .orderBy('s.id', 'DESC');
      if (scope) qb.andWhere('s.major_id IN (:...scope)', { scope });
      rows = await qb.getMany();
    } catch {
      throw new InternalServerErrorException(
        'Failed to fetch pending subjects',
      );
    }

    return rows.map((s) => this.subjectAdminShape(s));
  }

  async approveSubject(id: string, reviewer: Reviewer) {
    const subject = await this.subjects.findOne({
      where: { id },
      select: { name: true, submitted_by: true, major_id: true },
    });
    // The department comes from the subject, never from the request.
    if (subject) this.moderation.assertCanModerate(reviewer, subject.major_id);

    try {
      await this.subjects.update(
        { id },
        { status: 'active', reviewed_by: reviewer.id },
      );
    } catch {
      throw new InternalServerErrorException('Failed to approve subject');
    }

    if (subject?.submitted_by) {
      void this.notificationsService.create({
        user_id: subject.submitted_by,
        type: 'subject_approved',
        message: `Your subject "${subject.name}" has been approved.`,
        key: 'subjectApproved',
        params: { name: subject.name },
        ref_id: id,
        ref_type: 'subject',
      });
    }

    return { message: 'Subject approved' };
  }

  async rejectSubject(id: string, reviewer: Reviewer, reason?: string) {
    const subject = await this.subjects.findOne({
      where: { id },
      select: {
        name: true,
        submitted_by: true,
        subject_url: true,
        major_id: true,
      },
    });
    if (subject) this.moderation.assertCanModerate(reviewer, subject.major_id);

    const imageKey = this.storage.extractKey(subject?.subject_url ?? null);
    if (imageKey) await this.storage.remove([imageKey]);

    try {
      await this.subjects.update(
        { id },
        {
          status: 'rejected',
          rejection_reason: reason ?? null,
          rejected_at: new Date(),
          reviewed_by: reviewer.id,
        },
      );
    } catch {
      throw new InternalServerErrorException('Failed to reject subject');
    }

    if (subject?.submitted_by) {
      void this.notificationsService.create({
        user_id: subject.submitted_by,
        type: 'subject_rejected',
        message: `Your subject "${subject.name}" was not approved.${
          reason ? ` Reason: ${reason}` : ''
        }`,
        key: reason ? 'subjectRejectedReason' : 'subjectRejected',
        params: { name: subject.name, reason: reason ?? '' },
        ref_id: id,
        ref_type: 'subject',
      });
    }

    return { message: 'Subject rejected' };
  }

  async getAllSubjects(search?: string, majorId?: string, status?: string) {
    const qb = this.subjects
      .createQueryBuilder('s')
      .leftJoinAndSelect('s.major', 'major')
      .leftJoinAndSelect('s.submitter', 'submitter')
      .orderBy('s.status', 'ASC')
      .addOrderBy('s.id', 'DESC');

    if (search) qb.andWhere('s.name ILIKE :search', { search: `%${search}%` });
    if (majorId)
      qb.andWhere('s.major_id = :majorId', {
        majorId: this.assertUuid(majorId, 'major_id'),
      });
    if (status) {
      if (!SUBJECT_STATUSES.includes(status))
        throw new BadRequestException(
          `status must be one of: ${SUBJECT_STATUSES.join(', ')}`,
        );
      qb.andWhere('s.status = :status', { status });
    }

    let rows: Subject[];
    try {
      rows = await qb.getMany();
    } catch {
      throw new InternalServerErrorException('Failed to fetch subjects');
    }

    return rows.map((s) => ({
      ...this.subjectAdminShape(s),
      status: s.status,
    }));
  }

  private subjectAdminShape(s: Subject) {
    return {
      id: s.id,
      name: s.name,
      acronym: s.acronym,
      year_level: s.year_level,
      semester: s.semester,
      subject_url: s.subject_url,
      // The approvals queue filters and sorts by how long a submission has waited.
      created_at: s.created_at,
      majors: s.major ? { id: s.major.id, acronym: s.major.acronym } : null,
      users: s.submitter
        ? {
            id: s.submitter.id,
            first_name: s.submitter.first_name,
            last_name: s.submitter.last_name,
          }
        : null,
    };
  }

  async editSubject(
    id: string,
    dto: { name?: string; acronym?: string; semester?: number },
  ) {
    const updates: Partial<Subject> = {};
    if (dto.name?.trim()) updates.name = dto.name.trim();
    if (dto.acronym?.trim()) updates.acronym = dto.acronym.trim();
    if (dto.semester !== undefined) updates.semester = dto.semester;

    try {
      await this.subjects.update({ id }, updates);
    } catch {
      throw new InternalServerErrorException('Failed to update subject');
    }
    return { message: 'Subject updated' };
  }

  async removeSubject(id: string) {
    try {
      await this.subjects.delete({ id });
    } catch {
      throw new InternalServerErrorException('Failed to delete subject');
    }
    return { message: 'Subject deleted' };
  }

  // ─── Pending documents ─────────────────────────────────────────────────────

  async getPendingDocuments(reviewer: Reviewer) {
    const scope = this.moderation.scopeMajorIds(reviewer);
    if (scope?.length === 0) return [];

    let rows: Upload[];
    try {
      rows = await this.uploads.find({
        where: scope
          ? { status: 'pending', major_id: In(scope) }
          : { status: 'pending' },
        relations: {
          uploader: true,
          major: true,
          subject: true,
          documents: true,
        },
        order: { uploaded_at: 'DESC' },
      });
    } catch {
      throw new InternalServerErrorException(
        'Failed to fetch pending documents',
      );
    }

    // Flatten to match existing frontend shape: one row per file with group_id = upload id
    const groupRows = (
      await Promise.all(
        rows.map((upload) => this.flattenUpload(upload, false, 'group')),
      )
    ).flat();

    // Plus files added to an upload that is ALREADY approved. Those never
    // re-pend their upload — only the file waits — so they would otherwise
    // never reach a queue that looks at uploads.status alone.
    const fileQb = this.uploads
      .createQueryBuilder('u')
      .leftJoinAndSelect('u.uploader', 'uploader')
      .leftJoinAndSelect('u.major', 'major')
      .leftJoinAndSelect('u.subject', 'subject')
      // innerJoin: an upload with no pending file drops out entirely, and only
      // the pending files come back — an approved file is not up for review.
      .innerJoinAndSelect('u.documents', 'documents', 'documents.status = :p', {
        p: 'pending',
      })
      .where('u.status = :active', { active: 'active' })
      .orderBy('u.uploaded_at', 'DESC');

    if (scope) fileQb.andWhere('u.major_id IN (:...scope)', { scope });

    let fileUploads: Upload[];
    try {
      fileUploads = await fileQb.getMany();
    } catch {
      throw new InternalServerErrorException('Failed to fetch pending files');
    }

    const fileRows = (
      await Promise.all(
        fileUploads.map((upload) => this.flattenUpload(upload, false, 'file')),
      )
    ).flat();

    return [...groupRows, ...fileRows];
  }

  // ─── Document group (review page) ──────────────────────────────────────────

  /**
   * One upload and its files, for the review screen.
   *
   * Takes a reviewer because reaching this endpoint is not the same as being
   * allowed to read this upload: a moderator of one department must not open
   * another's by changing the id in the URL. The department is read from the
   * loaded upload, never from the request.
   */
  async getDocumentsByGroup(uploadId: string, reviewer: Reviewer) {
    const upload = await this.uploads.findOne({
      where: { id: uploadId },
      relations: {
        uploader: true,
        major: true,
        subject: true,
        documents: true,
      },
    });

    if (!upload) throw new NotFoundException('Upload not found');

    // The department comes from the upload, so the id in the URL decides WHICH
    // upload is checked, never WHETHER it is.
    this.moderation.assertCanModerate(reviewer, upload.major_id);

    // A pending upload is reviewed as a group. An active one can only be here
    // because files were added to it after approval — those are reviewed on
    // their own, and the group endpoints would find nothing to act on.
    return this.flattenUpload(
      upload,
      true,
      upload.status === 'pending' ? 'group' : 'file',
    );
  }

  // Flatten an upload into one row per file, matching the old Supabase shape.
  /**
   * `reviewScope` says what an approve/reject on this row acts on: 'group' for
   * a whole pending upload, 'file' for a single file added to an upload that is
   * already approved. The queue renders both, so it has to know which endpoint
   * to call.
   */
  private async flattenUpload(
    upload: Upload,
    includeStatus: boolean,
    reviewScope: 'group' | 'file' = 'group',
  ) {
    const meta = {
      group_id: upload.id,
      title: upload.title,
      doc_type: upload.doc_type,
      uploaded_at: upload.uploaded_at,
      users: upload.uploader
        ? {
            id: upload.uploader.id,
            first_name: upload.uploader.first_name,
            last_name: upload.uploader.last_name,
          }
        : null,
      majors: upload.major
        ? { id: upload.major.id, acronym: upload.major.acronym }
        : null,
      /** The cohort the upload is for; the queue shows it as "I3-GIC". */
      year_level: upload.year_level,
      /** Which academic year the material belongs to, e.g. "2021-2022". */
      academic_year: upload.academic_year,
      /**
       * Who may see it, as (department, year) pairs. Empty means everyone.
       * Ids rather than acronyms: this mapper is synchronous and the reviewer
       * screens already hold the department list they need to name them.
       */
      audience: upload.audience ?? [],
      /** Soft expiry. Null = never; past means hidden from all but staff. */
      expires_at: upload.expires_at,
      subjects: upload.subject
        ? {
            id: upload.subject.id,
            name: upload.subject.name,
            // The review tables show the acronym: a subject name can be long
            // enough to push every column after it off the row.
            acronym: upload.subject.acronym,
          }
        : null,
      review_scope: reviewScope,
      ...(includeStatus ? { status: upload.status } : {}),
    };

    // Signed, not stored: the documents bucket is private. A reviewer has
    // already been authorised for this department by the guard and
    // assertCanModerate above, so signing what the query returned is covered by
    // that same decision. Presigning is local, so this adds no round trips.
    return await Promise.all(
      (upload.documents ?? []).map(async (doc) => ({
        id: doc.id,
        file_url: await this.signRef(
          doc.storage_key,
          doc.file_url,
          doc.original_name,
        ),
        file_size_kb: doc.file_size_kb,
        // The approvals queue expands a submission to list — and preview — its files.
        original_name: doc.original_name,
        preview_url: await this.signRef(
          doc.preview_key,
          doc.preview_url,
          doc.original_name,
          true,
        ),
        // The FILE's own review state, distinct from `status` above (the
        // upload's). Only ever 'pending' on a review_scope: 'file' row.
        file_status: doc.status,
        ...meta,
      })),
    );
  }

  /** See DocumentsService.signOrFallback — same rule, same reasons. */
  private async signRef(
    ref: string | null,
    legacyUrl: string | null,
    downloadName: string | null,
    inline = false,
  ): Promise<string | null> {
    if (ref) {
      const signed = await this.storage.signedUrlForRef(ref, {
        downloadName,
        inline,
      });
      if (signed) return signed;
    }
    return legacyUrl;
  }

  // ─── Approve / reject upload group ────────────────────────────────────────

  async approveDocumentGroup(uploadId: string, reviewer: Reviewer) {
    const upload = await this.uploads.findOne({
      where: { id: uploadId, status: 'pending' },
      select: { id: true, title: true, uploader_id: true, major_id: true },
    });

    if (!upload) return { message: 'No pending upload found' };
    this.moderation.assertCanModerate(reviewer, upload.major_id);

    try {
      await this.uploads.update(
        { id: uploadId },
        { status: 'active', reviewed_by: reviewer.id },
      );
    } catch {
      throw new InternalServerErrorException('Failed to approve upload');
    }

    const fileCount = await this.documents.count({
      where: { upload_id: uploadId },
    });

    if (upload.uploader_id) {
      void this.notificationsService.create({
        user_id: upload.uploader_id,
        type: 'document_approved',
        message:
          fileCount === 1
            ? `Your document "${upload.title}" has been approved.`
            : `Your ${fileCount} documents have been approved.`,
        key: fileCount === 1 ? 'documentApproved' : 'documentsApproved',
        params: { title: upload.title, count: fileCount },
        ref_id: uploadId,
        ref_type: 'document',
      });
    }

    return { message: 'Documents approved' };
  }

  // ─── Approve / reject a single added file ─────────────────────────────────
  // A file added to an already-approved upload is reviewed on its own: the
  // upload and its approved files never left the feed, so there is no group to
  // act on — just this one file.

  /** Load a pending file with its upload, and check the reviewer covers it. */
  private async loadPendingFile(fileId: string, reviewer: Reviewer) {
    const file = await this.documents.findOne({
      where: { id: fileId, status: 'pending' },
      relations: { upload: true },
    });

    if (!file?.upload) return null;
    this.moderation.assertCanModerate(reviewer, file.upload.major_id);
    return file;
  }

  async approveFile(fileId: string, reviewer: Reviewer) {
    const file = await this.loadPendingFile(fileId, reviewer);
    if (!file) return { message: 'No pending file found' };

    try {
      await this.documents.update(
        { id: fileId },
        { status: 'active', reviewed_by: reviewer.id, rejection_reason: null },
      );
    } catch {
      throw new InternalServerErrorException('Failed to approve file');
    }

    if (file.upload.uploader_id) {
      void this.notificationsService.create({
        user_id: file.upload.uploader_id,
        type: 'document_approved',
        message: `The file you added to "${file.upload.title}" has been approved.`,
        key: 'fileApproved',
        params: { title: file.upload.title },
        ref_id: file.upload_id,
        ref_type: 'document',
      });
    }

    return { message: 'File approved' };
  }

  async rejectFile(fileId: string, reviewer: Reviewer, reason?: string) {
    const file = await this.loadPendingFile(fileId, reviewer);
    if (!file) return { message: 'No pending file found' };

    // The row and its object are kept, unlike a rejected group: the file never
    // reached anyone else, and leaving it intact lets the uploader open it,
    // read why it was turned down, and delete it themselves. A dead file_url
    // would just render as a broken tile on their own detail page.
    try {
      await this.documents.update(
        { id: fileId },
        {
          status: 'rejected',
          rejection_reason: reason ?? null,
          reviewed_by: reviewer.id,
        },
      );
    } catch {
      throw new InternalServerErrorException('Failed to reject file');
    }

    if (file.upload.uploader_id) {
      const name = file.original_name ?? 'file';
      void this.notificationsService.create({
        user_id: file.upload.uploader_id,
        type: 'document_rejected',
        message: `The file "${name}" you added to "${file.upload.title}" was not approved.${
          reason ? ` Reason: ${reason}` : ''
        }`,
        key: reason ? 'fileRejectedReason' : 'fileRejected',
        params: { name, title: file.upload.title, reason: reason ?? '' },
        ref_id: file.upload_id,
        ref_type: 'document',
      });
    }

    return { message: 'File rejected' };
  }

  async rejectDocumentGroup(
    uploadId: string,
    reviewer: Reviewer,
    reason?: string,
  ) {
    const upload = await this.uploads.findOne({
      where: { id: uploadId, status: 'pending' },
      select: { id: true, title: true, uploader_id: true, major_id: true },
    });

    if (!upload) return { message: 'No pending upload found' };
    this.moderation.assertCanModerate(reviewer, upload.major_id);

    // Delete all files from storage
    const files = await this.documents.find({
      where: { upload_id: uploadId },
      select: { file_url: true },
    });
    const keys = files
      .map((f) => this.storage.extractKey(f.file_url))
      .filter((k): k is string => k !== null);
    if (keys.length) await this.storage.remove(keys);

    try {
      await this.uploads.update(
        { id: uploadId },
        {
          status: 'rejected',
          rejection_reason: reason ?? null,
          rejected_at: new Date(),
          reviewed_by: reviewer.id,
        },
      );
    } catch {
      throw new InternalServerErrorException('Failed to reject upload');
    }

    const fileCount = files.length || 1;

    if (upload.uploader_id) {
      void this.notificationsService.create({
        user_id: upload.uploader_id,
        type: 'document_rejected',
        // Names the document when there is only one, matching the approval.
        message:
          fileCount > 1
            ? `Your ${fileCount} documents were not approved.${reason ? ` Reason: ${reason}` : ''}`
            : `Your document "${upload.title}" was not approved.${reason ? ` Reason: ${reason}` : ''}`,
        key: `${fileCount > 1 ? 'documentsRejected' : 'documentRejected'}${reason ? 'Reason' : ''}`,
        params: { title: upload.title, count: fileCount, reason: reason ?? '' },
        ref_id: uploadId,
        ref_type: 'document',
      });
    }

    return { message: 'Documents rejected' };
  }

  // ─── Admin delete upload ───────────────────────────────────────────────────

  async deleteDocument(uploadId: string) {
    const upload = await this.uploads.findOne({
      where: { id: uploadId },
      select: { id: true },
    });

    if (!upload) throw new NotFoundException('Upload not found');

    const files = await this.documents.find({
      where: { upload_id: uploadId },
      select: { file_url: true },
    });
    const keys = files
      .map((f) => this.storage.extractKey(f.file_url))
      .filter((k): k is string => k !== null);
    if (keys.length) await this.storage.remove(keys);

    // CASCADE removes documents
    try {
      await this.uploads.delete({ id: uploadId });
    } catch {
      throw new InternalServerErrorException('Failed to delete upload');
    }

    return { message: 'Upload deleted' };
  }
}
