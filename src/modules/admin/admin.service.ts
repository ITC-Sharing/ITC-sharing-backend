import {
  Injectable,
  InternalServerErrorException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { User } from '../../entities/user.entity';
import { Upload } from '../../entities/upload.entity';
import { DocumentFile } from '../../entities/document.entity';
import { Subject } from '../../entities/subject.entity';
import { RefreshToken } from '../../entities/refresh-token.entity';
import { Book } from '../../entities/book.entity';
import { StorageService } from '../storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ModerationService, Reviewer } from './moderation.service';

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
    private readonly storage: StorageService,
    private readonly notificationsService: NotificationsService,
    private readonly moderation: ModerationService,
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
      description: u.description,
      documents: (u.documents ?? []).map((d) => ({
        id: d.id,
        file_url: d.file_url,
        original_name: d.original_name,
        file_size_kb: d.file_size_kb,
        // The expanded row previews office files through their PDF rendition.
        preview_url: d.preview_url,
      })),
    }));
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
      message: 'Your account has been reinstated.',
      ref_id: targetId,
      ref_type: 'user',
    });

    return { message: 'User unbanned' };
  }

  // ─── Subjects ──────────────────────────────────────────────────────────────

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
        message: reason
          ? `Your subject "${subject.name}" was not approved: ${reason}`
          : `Your subject "${subject.name}" was not approved.`,
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
    if (majorId) qb.andWhere('s.major_id = :majorId', { majorId: this.assertUuid(majorId, 'major_id') });
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
    const groupRows = rows.flatMap((upload) =>
      this.flattenUpload(upload, false, 'group'),
    );

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

    const fileRows = fileUploads.flatMap((upload) =>
      this.flattenUpload(upload, false, 'file'),
    );

    return [...groupRows, ...fileRows];
  }

  // ─── Document group (review page) ──────────────────────────────────────────

  async getDocumentsByGroup(uploadId: string) {
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
  private flattenUpload(
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
      subjects: upload.subject
        ? { id: upload.subject.id, name: upload.subject.name }
        : null,
      review_scope: reviewScope,
      ...(includeStatus ? { status: upload.status } : {}),
    };

    return (upload.documents ?? []).map((doc) => ({
      id: doc.id,
      file_url: doc.file_url,
      file_size_kb: doc.file_size_kb,
      // The approvals queue expands a submission to list — and preview — its files.
      original_name: doc.original_name,
      preview_url: doc.preview_url,
      // The FILE's own review state, distinct from `status` above (the
      // upload's). Only ever 'pending' on a review_scope: 'file' row.
      file_status: doc.status,
      ...meta,
    }));
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
            : `Your ${fileCount} uploaded documents have been approved.`,
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
        message: reason
          ? `The file "${name}" you added to "${file.upload.title}" was not approved: ${reason}`
          : `The file "${name}" you added to "${file.upload.title}" was not approved.`,
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
        message: reason
          ? `Your uploaded document${fileCount > 1 ? 's were' : ' was'} not approved: ${reason}`
          : `Your uploaded document${fileCount > 1 ? 's were' : ' was'} not approved.`,
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
