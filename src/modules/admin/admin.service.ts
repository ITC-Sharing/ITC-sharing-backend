import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../entities/user.entity';
import { Upload } from '../../entities/upload.entity';
import { DocumentFile } from '../../entities/document.entity';
import { Subject } from '../../entities/subject.entity';
import { StorageService } from '../storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';

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
    private readonly storage: StorageService,
    private readonly notificationsService: NotificationsService,
  ) {}

  // ─── Stats ─────────────────────────────────────────────────────────────────

  async getStats() {
    const [totalUsers, totalDocuments] = await Promise.all([
      this.users.count(),
      this.uploads.count({ where: { status: 'active' } }),
    ]);

    return { totalUsers, totalDocuments };
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

    return rows.map((u) => ({
      id: u.id,
      first_name: u.first_name,
      last_name: u.last_name,
      email: u.email,
      role: u.role,
      year_level: u.year_level,
      created_at: u.created_at,
      majors: u.major ? { id: u.major.id, acronym: u.major.acronym } : null,
    }));
  }

  // ─── All documents (admin table view) ─────────────────────────────────────

  async getAllDocuments(search?: string, docType?: string) {
    const qb = this.uploads
      .createQueryBuilder('u')
      .leftJoinAndSelect('u.uploader', 'uploader')
      .leftJoinAndSelect('u.major', 'major')
      .leftJoinAndSelect('u.subject', 'subject')
      .leftJoinAndSelect('u.tags', 'tags')
      .leftJoinAndSelect('u.documents', 'documents')
      .where('u.status = :status', { status: 'active' })
      .orderBy('u.uploaded_at', 'DESC');

    if (search) qb.andWhere('u.title ILIKE :search', { search: `%${search}%` });
    if (docType) qb.andWhere('u.doc_type = :docType', { docType });

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
      document_tags: (u.tags ?? []).map((t) => ({ tag: t.tag })),
      documents: (u.documents ?? []).map((d) => ({
        id: d.id,
        file_url: d.file_url,
        original_name: d.original_name,
        file_size_kb: d.file_size_kb,
      })),
    }));
  }

  // ─── Subjects ──────────────────────────────────────────────────────────────

  async getPendingSubjects() {
    let rows: Subject[];
    try {
      rows = await this.subjects
        .createQueryBuilder('s')
        .leftJoinAndSelect('s.major', 'major')
        .leftJoinAndSelect('s.submitter', 'submitter')
        .where('s.status = :status', { status: 'pending' })
        .orderBy('s.id', 'DESC')
        .getMany();
    } catch {
      throw new InternalServerErrorException(
        'Failed to fetch pending subjects',
      );
    }

    return rows.map((s) => this.subjectAdminShape(s));
  }

  async approveSubject(id: string) {
    const subject = await this.subjects.findOne({
      where: { id },
      select: { name: true, submitted_by: true },
    });

    try {
      await this.subjects.update({ id }, { status: 'active' });
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

  async rejectSubject(id: string, reason?: string) {
    const subject = await this.subjects.findOne({
      where: { id },
      select: { name: true, submitted_by: true, subject_url: true },
    });

    const imageKey = this.storage.extractKey(subject?.subject_url ?? null);
    if (imageKey) await this.storage.remove([imageKey]);

    try {
      await this.subjects.update(
        { id },
        {
          status: 'rejected',
          rejection_reason: reason ?? null,
          rejected_at: new Date(),
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

  async getAllSubjects(search?: string) {
    const qb = this.subjects
      .createQueryBuilder('s')
      .leftJoinAndSelect('s.major', 'major')
      .leftJoinAndSelect('s.submitter', 'submitter')
      .orderBy('s.status', 'ASC')
      .addOrderBy('s.id', 'DESC');

    if (search) qb.where('s.name ILIKE :search', { search: `%${search}%` });

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
      slug: s.slug,
      year_level: s.year_level,
      semester: s.semester,
      subject_url: s.subject_url,
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
    dto: { name?: string; slug?: string; semester?: number },
  ) {
    const updates: Partial<Subject> = {};
    if (dto.name?.trim()) updates.name = dto.name.trim();
    if (dto.slug?.trim()) updates.slug = dto.slug.trim();
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

  async getPendingDocuments() {
    let rows: Upload[];
    try {
      rows = await this.uploads.find({
        where: { status: 'pending' },
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
    return rows.flatMap((upload) => this.flattenUpload(upload, false));
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

    return this.flattenUpload(upload, true);
  }

  // Flatten an upload into one row per file, matching the old Supabase shape.
  private flattenUpload(upload: Upload, includeStatus: boolean) {
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
      ...(includeStatus ? { status: upload.status } : {}),
    };

    return (upload.documents ?? []).map((doc) => ({
      id: doc.id,
      file_url: doc.file_url,
      file_size_kb: doc.file_size_kb,
      ...(includeStatus ? { original_name: doc.original_name } : {}),
      ...meta,
    }));
  }

  // ─── Approve / reject upload group ────────────────────────────────────────

  async approveDocumentGroup(uploadId: string) {
    const upload = await this.uploads.findOne({
      where: { id: uploadId, status: 'pending' },
      select: { id: true, title: true, uploader_id: true },
    });

    if (!upload) return { message: 'No pending upload found' };

    try {
      await this.uploads.update({ id: uploadId }, { status: 'active' });
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

  async rejectDocumentGroup(uploadId: string, reason?: string) {
    const upload = await this.uploads.findOne({
      where: { id: uploadId, status: 'pending' },
      select: { id: true, title: true, uploader_id: true },
    });

    if (!upload) return { message: 'No pending upload found' };

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

    // CASCADE removes documents + document_tags
    try {
      await this.uploads.delete({ id: uploadId });
    } catch {
      throw new InternalServerErrorException('Failed to delete upload');
    }

    return { message: 'Upload deleted' };
  }
}
