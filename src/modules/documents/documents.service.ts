import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Upload } from '../../entities/upload.entity';
import { DocumentFile } from '../../entities/document.entity';
import { DocumentTag } from '../../entities/document-tag.entity';
import { BUCKETS, StorageService } from '../storage/storage.service';
import { pgCode } from '../../common/utils/pg-error';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { QueryDocumentsDto } from './dto/query-documents.dto';

// Applied when a caller omits `limit`. Without it the feed returned every
// matching upload joined to its uploader, major, subject, tags and files —
// unbounded, and no index can help with that. Matches the DTO's Max(50) ceiling.
const DEFAULT_PAGE_SIZE = 24;

@Injectable()
export class DocumentsService {
  constructor(
    @InjectRepository(Upload)
    private readonly uploads: Repository<Upload>,
    @InjectRepository(DocumentFile)
    private readonly documents: Repository<DocumentFile>,
    @InjectRepository(DocumentTag)
    private readonly tags: Repository<DocumentTag>,
    private readonly storage: StorageService,
  ) {}

  // ─── Upload ────────────────────────────────────────────────────────────────

  async uploadMany(
    uploaderId: string,
    dto: CreateDocumentDto,
    files: Express.Multer.File[],
  ) {
    if (!files?.length) throw new BadRequestException('No files provided');

    const title = this.resolveTitle(dto.title, files[0].originalname);

    // 1. One uploads row for the entire batch
    let upload: Upload;
    try {
      upload = await this.uploads.save(
        this.uploads.create({
          uploader_id: uploaderId,
          major_id: dto.major_id,
          subject_id: dto.subject_id ?? null,
          title,
          doc_type: dto.doc_type,
          year_level: dto.year_level,
          academic_year: dto.academic_year ?? null,
          status: 'pending',
        }),
      );
    } catch (err) {
      if (pgCode(err) === '23503')
        throw new BadRequestException('Invalid major_id or subject_id');
      throw new InternalServerErrorException('Failed to create upload record');
    }

    // 2. One documents row per file
    const fileResults: unknown[] = [];
    for (const file of files) {
      fileResults.push(
        await this.uploadFile(upload.id, uploaderId, dto.major_id, file),
      );
    }

    // 3. Tags reference upload_id
    if (dto.tags?.length) {
      await this.tags.insert(
        dto.tags.map((tag) => ({
          upload_id: upload.id,
          tag: tag.toLowerCase().trim(),
        })),
      );
    }

    return { upload_id: upload.id, files: fileResults };
  }

  private async uploadFile(
    uploadId: string,
    uploaderId: string,
    majorId: string,
    file: Express.Multer.File,
  ) {
    const ext = file.originalname.split('.').pop();
    const key = `${majorId}/${uploaderId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    let fileUrl: string;
    try {
      fileUrl = await this.storage.upload(
        BUCKETS.DOCUMENTS,
        key,
        file.buffer,
        file.mimetype,
      );
    } catch {
      throw new InternalServerErrorException('File upload failed');
    }

    try {
      const doc = await this.documents.save(
        this.documents.create({
          upload_id: uploadId,
          file_url: fileUrl,
          original_name: file.originalname,
          file_size_kb: Math.round(file.size / 1024),
        }),
      );
      return {
        id: doc.id,
        upload_id: doc.upload_id,
        file_url: doc.file_url,
        original_name: doc.original_name,
        file_size_kb: doc.file_size_kb,
      };
    } catch {
      await this.storage.remove([`${BUCKETS.DOCUMENTS}/${key}`]);
      throw new InternalServerErrorException('Failed to save document record');
    }
  }

  private resolveTitle(title: string | undefined, originalName: string) {
    const trimmed = title?.trim();
    if (trimmed) return trimmed;
    return originalName.replace(/\.[^.]+$/, '');
  }

  // Reshape an Upload entity (+ relations) into the shape the frontend expects,
  // matching the old Supabase nested-select output.
  private toFeedShape(u: Upload) {
    return {
      id: u.id,
      title: u.title,
      doc_type: u.doc_type,
      year_level: u.year_level,
      academic_year: u.academic_year,
      uploaded_at: u.uploaded_at,
      users: u.uploader
        ? {
            id: u.uploader.id,
            first_name: u.uploader.first_name,
            last_name: u.uploader.last_name,
            avatar_url: u.uploader.avatar_url,
          }
        : null,
      majors: u.major ? { id: u.major.id, acronym: u.major.acronym } : null,
      subjects: u.subject
        ? { id: u.subject.id, name: u.subject.name, slug: u.subject.slug }
        : null,
      document_tags: (u.tags ?? []).map((t) => ({ tag: t.tag })),
      documents: (u.documents ?? []).map((d) => ({
        id: d.id,
        file_url: d.file_url,
        file_size_kb: d.file_size_kb,
        original_name: d.original_name,
      })),
    };
  }

  // ─── List ──────────────────────────────────────────────────────────────────

  async findAll(query: QueryDocumentsDto) {
    const qb = this.uploads
      .createQueryBuilder('u')
      .leftJoinAndSelect('u.uploader', 'uploader')
      .leftJoinAndSelect('u.major', 'major')
      .leftJoinAndSelect('u.subject', 'subject')
      .leftJoinAndSelect('u.tags', 'tags')
      .leftJoinAndSelect('u.documents', 'documents')
      .where('u.status = :status', { status: 'active' })
      .orderBy('u.uploaded_at', 'DESC');

    if (query.major_id)
      qb.andWhere('u.major_id = :major_id', { major_id: query.major_id });
    if (query.subject_id)
      qb.andWhere('u.subject_id = :subject_id', {
        subject_id: query.subject_id,
      });
    if (query.doc_type)
      qb.andWhere('u.doc_type = :doc_type', { doc_type: query.doc_type });
    if (query.year_level)
      qb.andWhere('u.year_level = :year_level', {
        year_level: query.year_level,
      });
    if (query.academic_year)
      qb.andWhere('u.academic_year = :academic_year', {
        academic_year: query.academic_year,
      });
    if (query.search)
      qb.andWhere('u.title ILIKE :search', { search: `%${query.search}%` });
    if (query.uploader_id)
      qb.andWhere('u.uploader_id = :uploader_id', {
        uploader_id: query.uploader_id,
      });

    // Always paginated. Callers that omit `limit` get DEFAULT_PAGE_SIZE rather
    // than the whole table; `total` still reflects every match, so existing
    // callers can page through without changing how they read the response.
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const page = query.page && query.page > 0 ? query.page : 1;
    qb.skip((page - 1) * limit).take(limit);

    try {
      const [rows, total] = await qb.getManyAndCount();
      return {
        items: rows.map((u) => this.toFeedShape(u)),
        total,
        page,
        limit,
      };
    } catch {
      throw new InternalServerErrorException('Failed to fetch documents');
    }
  }

  // ─── Stats ─────────────────────────────────────────────────────────────────

  /**
   * Dashboard totals for one uploader. Aggregated in SQL — the dashboard used
   * to derive these by fetching every one of the user's uploads and summing in
   * the browser, which stops being viable once the feed is paginated (and was
   * never viable as upload counts grow).
   */
  async getStats(uploaderId: string) {
    const row = await this.uploads
      .createQueryBuilder('u')
      .leftJoin('u.documents', 'd')
      .select('count(distinct u.id)', 'total')
      .addSelect('coalesce(sum(d.file_size_kb), 0)', 'size_kb')
      .where('u.uploader_id = :uploaderId', { uploaderId })
      .andWhere('u.status = :status', { status: 'active' })
      .getRawOne<{ total: string; size_kb: string }>();

    // Postgres returns count/sum as strings via the driver.
    return {
      total: Number(row?.total ?? 0),
      size_kb: Number(row?.size_kb ?? 0),
    };
  }

  // ─── Get one ───────────────────────────────────────────────────────────────

  async findOne(uploadId: string) {
    const upload = await this.uploads
      .createQueryBuilder('u')
      .leftJoinAndSelect('u.uploader', 'uploader')
      .leftJoinAndSelect('u.major', 'major')
      .leftJoinAndSelect('u.subject', 'subject')
      .leftJoinAndSelect('u.tags', 'tags')
      .leftJoinAndSelect('u.documents', 'documents')
      .where('u.id = :id', { id: uploadId })
      .andWhere('u.status = :status', { status: 'active' })
      .getOne();

    if (!upload) throw new NotFoundException('Document not found');
    return this.toFeedShape(upload);
  }

  // ─── Update own upload (metadata only) ──────────────────────────────────────

  async update(uploadId: string, userId: string, dto: UpdateDocumentDto) {
    const upload = await this.uploads.findOne({
      where: { id: uploadId },
      select: { id: true, uploader_id: true, status: true },
    });

    if (!upload) throw new NotFoundException('Upload not found');
    if (upload.uploader_id !== userId)
      throw new ForbiddenException('Not your upload');

    // Build the patch — only fields that were sent.
    const patch: Partial<Upload> = {};
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.doc_type !== undefined) patch.doc_type = dto.doc_type;
    if (dto.major_id !== undefined) patch.major_id = dto.major_id;
    if (dto.subject_id !== undefined) patch.subject_id = dto.subject_id ?? null;
    if (dto.year_level !== undefined) patch.year_level = dto.year_level;
    if (dto.academic_year !== undefined)
      patch.academic_year = dto.academic_year ?? null;

    // Editing sends the upload back for review.
    if (upload.status !== 'active') {
      patch.status = 'pending';
      patch.rejection_reason = null;
    }

    if (Object.keys(patch).length) {
      try {
        await this.uploads.update({ id: uploadId }, patch);
      } catch (err) {
        if (pgCode(err) === '23503')
          throw new BadRequestException('Invalid major_id or subject_id');
        throw new InternalServerErrorException('Failed to update upload');
      }
    }

    // Replace tags wholesale when provided.
    if (dto.tags !== undefined) {
      await this.tags.delete({ upload_id: uploadId });
      if (dto.tags.length) {
        await this.tags.insert(
          dto.tags.map((tag: string) => ({
            upload_id: uploadId,
            tag: tag.toLowerCase().trim(),
          })),
        );
      }
    }

    return { message: 'Upload updated' };
  }

  /** Add files to an existing upload (uploader only). */
  async addFiles(
    uploadId: string,
    userId: string,
    files: Express.Multer.File[],
  ) {
    if (!files?.length) throw new BadRequestException('No files provided');

    const upload = await this.uploads.findOne({
      where: { id: uploadId },
      select: { id: true, uploader_id: true, major_id: true, status: true },
    });

    if (!upload) throw new NotFoundException('Upload not found');
    if (upload.uploader_id !== userId)
      throw new ForbiddenException('Not your upload');

    const results: unknown[] = [];
    for (const file of files) {
      results.push(
        await this.uploadFile(uploadId, userId, upload.major_id, file),
      );
    }

    // Editing sends the upload back for review.
    if (upload.status !== 'active') {
      await this.uploads.update(
        { id: uploadId },
        { status: 'pending', rejection_reason: null },
      );
    }

    return { files: results };
  }

  /** Remove one file from an upload (uploader only). An upload must keep ≥1 file. */
  async removeFile(fileId: string, userId: string) {
    const file = await this.documents.findOne({
      where: { id: fileId },
      select: { id: true, file_url: true, upload_id: true },
    });

    if (!file) throw new NotFoundException('File not found');

    const upload = await this.uploads.findOne({
      where: { id: file.upload_id },
      select: { id: true, uploader_id: true },
    });

    if (!upload) throw new NotFoundException('Upload not found');
    if (upload.uploader_id !== userId)
      throw new ForbiddenException('Not your upload');

    const count = await this.documents.count({
      where: { upload_id: file.upload_id },
    });

    if (count <= 1)
      throw new BadRequestException('An upload must keep at least one file');

    const key = this.storage.extractKey(file.file_url);
    if (key) await this.storage.remove([key]);

    try {
      await this.documents.delete({ id: fileId });
    } catch {
      throw new InternalServerErrorException('Failed to remove file');
    }

    return { message: 'File removed' };
  }

  async delete(uploadId: string, userId: string) {
    const upload = await this.uploads.findOne({
      where: { id: uploadId },
      select: { id: true, uploader_id: true },
    });

    if (!upload) throw new NotFoundException('Upload not found');
    if (upload.uploader_id !== userId)
      throw new ForbiddenException('Not your upload');

    const files = await this.documents.find({
      where: { upload_id: uploadId },
      select: { file_url: true },
    });

    const keys = files
      .map((f) => this.storage.extractKey(f.file_url))
      .filter((k): k is string => k !== null);
    if (keys.length) await this.storage.remove(keys);

    // CASCADE deletes documents + document_tags
    try {
      await this.uploads.delete({ id: uploadId });
    } catch {
      throw new InternalServerErrorException('Failed to delete upload');
    }

    return { message: 'Upload deleted' };
  }

  // ─── My uploads (pending / rejected) ──────────────────────────────────────

  async findMine(userId: string) {
    let rows: Upload[];
    try {
      rows = await this.uploads
        .createQueryBuilder('u')
        .leftJoinAndSelect('u.major', 'major')
        .leftJoinAndSelect('u.subject', 'subject')
        .leftJoinAndSelect('u.tags', 'tags')
        .leftJoinAndSelect('u.documents', 'documents')
        .where('u.uploader_id = :userId', { userId })
        .andWhere('u.status IN (:...statuses)', {
          statuses: ['pending', 'rejected'],
        })
        .orderBy('u.uploaded_at', 'DESC')
        .getMany();
    } catch {
      throw new InternalServerErrorException('Failed to fetch your documents');
    }

    return rows.map((u) => ({
      id: u.id,
      title: u.title,
      doc_type: u.doc_type,
      year_level: u.year_level,
      academic_year: u.academic_year,
      status: u.status,
      rejection_reason: u.rejection_reason,
      rejected_at: u.rejected_at,
      uploaded_at: u.uploaded_at,
      subjects: u.subject ? { id: u.subject.id, name: u.subject.name } : null,
      majors: u.major ? { id: u.major.id, acronym: u.major.acronym } : null,
      document_tags: (u.tags ?? []).map((t) => ({ tag: t.tag })),
      documents: (u.documents ?? []).map((d) => ({
        id: d.id,
        original_name: d.original_name,
        file_size_kb: d.file_size_kb,
      })),
    }));
  }
}
