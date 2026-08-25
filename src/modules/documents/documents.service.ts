import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { AudienceEntry, Upload } from '../../entities/upload.entity';
import { DocumentFile } from '../../entities/document.entity';
import { StagedFile } from '../../entities/staged-file.entity';
import { User } from '../../entities/user.entity';
import { Major } from '../../entities/major.entity';
import { BUCKETS, StorageService } from '../storage/storage.service';
import { OfficeConvertService } from '../storage/office-convert.service';
import { pgCode } from '../../common/utils/pg-error';
import { LANGUAGE_MAJOR_ACRONYMS } from '../../common/constants/majors';
import { yearLevelsForMajor } from '../../common/utils/year-levels';
import {
  CreateDocumentDto,
  DEPARTMENT_DOC_TYPES,
  DocType,
  LANGUAGE_DOC_TYPES,
} from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { QueryDocumentsDto } from './dto/query-documents.dto';

// Applied when a caller omits `limit`. Without it the feed returned every
// matching upload joined to its uploader, major, subject, tags and files —
// unbounded, and no index can help with that. Matches the DTO's Max(50) ceiling.
const DEFAULT_PAGE_SIZE = 24;

/** Review state of a single file — see DocumentFile.status. */
type DocumentStatus = 'pending' | 'active' | 'rejected';

@Injectable()
export class DocumentsService {
  constructor(
    @InjectRepository(Upload)
    private readonly uploads: Repository<Upload>,
    @InjectRepository(DocumentFile)
    private readonly documents: Repository<DocumentFile>,
    @InjectRepository(StagedFile)
    private readonly stagedFiles: Repository<StagedFile>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(Major)
    private readonly majors: Repository<Major>,
    private readonly storage: StorageService,
    private readonly officeConvert: OfficeConvertService,
  ) {}

  /**
   * Restrict a feed query to uploads the viewer is allowed to see. A viewer
   * sees an upload when it's public, they uploaded it, they're an admin, or
   * their department/year matches the upload's audience rule. Applied as an
   * AND on the query builder (`u` is the uploads alias). `paramPrefix` keeps
   * bound params unique if this is ever called twice on one builder.
   */
  private applyVisibility(
    qb: import('typeorm').SelectQueryBuilder<Upload>,
    viewer: { id: string; role: string; major_id: string | null; year_level: number | null },
    // When true (the owner listing their own uploads — the dashboard), expired
    // uploads are kept. In the browse feed it's false, so expiry hides a doc
    // from EVERYONE including its uploader; the owner only sees it again in the
    // dashboard (where they can extend or delete it).
    includeExpired = false,
  ) {
    // Expiry hides a doc from the browse feed for EVERYONE, admins included,
    // unless includeExpired (the owner's own-docs dashboard listing).
    const notExpired =
      '(:includeExpired OR u.expires_at IS NULL OR u.expires_at > now())';

    if (viewer.role === 'admin') {
      // Admins bypass the audience restriction (for moderation) but not expiry.
      qb.andWhere(notExpired, { includeExpired });
      return;
    }

    // Not expired AND the viewer either uploaded it or their own (department,
    // year) is one of the pairs the audience lists. An empty array is no
    // restriction — which is also what language-course uploads always store,
    // since every student takes those.
    qb.andWhere(
      `(
        ${notExpired}
        AND (
          u.uploader_id = :viewerId
          OR jsonb_array_length(u.audience) = 0
          OR u.audience @> :viewerAudience::jsonb
        )
      )`,
      {
        includeExpired,
        viewerId: viewer.id,
        // A profile with no department/year gets a pair that can never match,
        // rather than accidentally satisfying a restricted upload.
        viewerAudience: JSON.stringify([
          {
            major_id: viewer.major_id ?? '00000000-0000-0000-0000-000000000000',
            year_level: viewer.year_level ?? -1,
          },
        ]),
      },
    );
  }

  /** True if `viewer` may see an already-loaded upload (detail endpoint). */
  private canView(
    upload: Upload,
    viewer: { id: string; role: string; major_id: string | null; year_level: number | null },
  ): boolean {
    if (viewer.role === 'admin') return true;
    if (upload.uploader_id === viewer.id) return true;
    // Expired uploads are hidden from everyone but the uploader/admins.
    if (upload.expires_at && new Date(upload.expires_at) <= new Date()) return false;
    const audience = upload.audience ?? [];
    if (!audience.length) return true; // no restriction
    return audience.some(
      (entry) =>
        entry.major_id === viewer.major_id &&
        entry.year_level === viewer.year_level,
    );
  }

  private isLanguageMajor(acronym: string) {
    return LANGUAGE_MAJOR_ACRONYMS.includes(acronym.toLowerCase());
  }

  private async loadMajor(majorId: string): Promise<Major> {
    const major = await this.majors.findOne({ where: { id: majorId } });
    if (!major) throw new BadRequestException('Invalid major_id');
    return major;
  }

  /**
   * A language course produces different material than a department course, so
   * each offers its own set of document types (see DEPARTMENT_DOC_TYPES /
   * LANGUAGE_DOC_TYPES). The upload form only shows the right one; this stops
   * anything else from reaching the database.
   */
  private assertDocType(major: Major, docType: DocType) {
    const allowed = this.isLanguageMajor(major.acronym)
      ? LANGUAGE_DOC_TYPES
      : DEPARTMENT_DOC_TYPES;
    if (!allowed.includes(docType))
      throw new BadRequestException(
        `doc_type '${docType}' is not available for ${major.acronym}`,
      );
  }

  /**
   * Work out the audience to store for an upload in `major`.
   *
   * The Department of Foreign Languages is taken by every student, so its
   * uploads carry no audience at all — both arrays are cleared and everyone in
   * every year sees them. The upload form hides both axes for those docs.
   *
   * For every other upload the pairs are taken as given — an empty list is the
   * "Everyone" choice in the form and means no restriction. Each department must
   * be a real major, and never the language department: that id matches no
   * viewer — no one registers into it — so such a pair would make the upload
   * silently invisible. The year has to be one that department actually has
   * students in, for the same reason.
   */
  private async resolveAudience(
    major: Major,
    audience: AudienceEntry[],
  ): Promise<Pick<Upload, 'audience'>> {
    if (this.isLanguageMajor(major.acronym)) return { audience: [] };

    // Same pair twice is harmless but pointless — store it once.
    const unique = [
      ...new Map(
        audience.map((a) => [`${a.major_id}:${a.year_level}`, a]),
      ).values(),
    ];

    const majorIds = [...new Set(unique.map((a) => a.major_id))];
    const found = await this.majors.find({ where: { id: In(majorIds) } });
    if (found.length !== majorIds.length)
      throw new BadRequestException('Unknown department in audience');

    const byId = new Map(found.map((m) => [m.id, m]));
    for (const entry of unique) {
      const audienceMajor = byId.get(entry.major_id)!;
      if (this.isLanguageMajor(audienceMajor.acronym))
        throw new BadRequestException(
          'A language course cannot be an audience department',
        );
      if (!yearLevelsForMajor(audienceMajor.acronym).includes(entry.year_level))
        throw new BadRequestException(
          `${audienceMajor.acronym} has no year ${entry.year_level}`,
        );
    }

    return { audience: unique };
  }

  /** Load the viewer's audience attributes (role, department, year). */
  private async getViewer(viewerId: string) {
    const user = await this.users.findOne({
      where: { id: viewerId },
      select: { id: true, role: true, major_id: true, year_level: true },
    });
    // Fall back to a least-privilege viewer if the id somehow isn't found.
    return (
      user ?? { id: viewerId, role: 'user', major_id: null, year_level: null }
    );
  }

  // ─── Staged files ──────────────────────────────────────────────────────────
  // The form sends each file as soon as it's picked, so the transfer overlaps
  // with the user filling in the metadata. The bytes land in MinIO right away;
  // POST /documents then claims them by id.

  /**
   * Office files can't be previewed by browsers directly — render a PDF beside
   * the original (best effort). A failure leaves the preview null; the upload
   * still succeeds.
   */
  private async buildPreview(baseKey: string, file: Express.Multer.File) {
    if (!this.officeConvert.canConvert(file.originalname))
      return { url: null, key: null };

    const pdf = await this.officeConvert.toPdf(file.buffer, file.originalname);
    if (!pdf) return { url: null, key: null };

    const key = `${baseKey}.preview.pdf`;
    try {
      const url = await this.storage.upload(
        BUCKETS.DOCUMENTS,
        key,
        pdf,
        'application/pdf',
      );
      return { url, key };
    } catch {
      return { url: null, key: null }; // upload failed — nothing to clean up
    }
  }

  /** How long an unclaimed staged file survives before the sweep removes it. */
  private static readonly STAGED_TTL_HOURS = 24;

  /**
   * Store one file and return the handle the form holds on to. The object goes
   * under `staged/<uploader>/…` because the department isn't known yet — it
   * stays at that key once claimed; the prefix is only cosmetic.
   */
  async stageFile(uploaderId: string, file: Express.Multer.File) {
    // Cheap moment to clean up after abandoned forms: no scheduler needed, and
    // it only touches this user's rows.
    await this.purgeStaleStaged(uploaderId);

    const ext = file.originalname.split('.').pop();
    const baseKey = `staged/${uploaderId}/${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const key = `${baseKey}.${ext}`;

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

    const preview = await this.buildPreview(baseKey, file);

    try {
      const staged = await this.stagedFiles.save(
        this.stagedFiles.create({
          uploader_id: uploaderId,
          file_url: fileUrl,
          storage_key: key,
          preview_url: preview.url,
          preview_key: preview.key,
          original_name: file.originalname,
          file_size_kb: Math.round(file.size / 1024),
        }),
      );
      return {
        id: staged.id,
        file_url: staged.file_url,
        preview_url: staged.preview_url,
        original_name: staged.original_name,
        file_size_kb: staged.file_size_kb,
      };
    } catch {
      await this.storage.remove(
        this.stagedObjectPaths({ storage_key: key, preview_key: preview.key }),
      );
      throw new InternalServerErrorException('Failed to stage file');
    }
  }

  /** Discard a staged file — the user removed it from the form. */
  async deleteStagedFile(id: string, uploaderId: string) {
    const staged = await this.stagedFiles.findOne({ where: { id } });
    if (!staged) throw new NotFoundException('Staged file not found');
    if (staged.uploader_id !== uploaderId)
      throw new ForbiddenException('Not your file');

    await this.storage.remove(this.stagedObjectPaths(staged));
    await this.stagedFiles.delete({ id });
    return { message: 'Staged file removed' };
  }

  private stagedObjectPaths(staged: {
    storage_key: string;
    preview_key?: string | null;
  }) {
    return [
      `${BUCKETS.DOCUMENTS}/${staged.storage_key}`,
      ...(staged.preview_key
        ? [`${BUCKETS.DOCUMENTS}/${staged.preview_key}`]
        : []),
    ];
  }

  /** Drop this user's staged files that were never claimed. */
  private async purgeStaleStaged(uploaderId: string) {
    const cutoff = new Date(
      Date.now() - DocumentsService.STAGED_TTL_HOURS * 60 * 60 * 1000,
    );
    const stale = await this.stagedFiles.find({
      where: { uploader_id: uploaderId, created_at: LessThan(cutoff) },
    });
    if (!stale.length) return;
    await this.storage.remove(stale.flatMap((s) => this.stagedObjectPaths(s)));
    await this.stagedFiles.delete(stale.map((s) => s.id));
  }

  /**
   * Turn the caller's staged files into `documents` rows for `uploadId`. Ids
   * that aren't theirs (or were already claimed) are rejected rather than
   * silently skipped, so a bad payload can't produce an upload with no files.
   */
  private async claimStagedFiles(
    uploadId: string,
    uploaderId: string,
    stagedIds: string[],
    status: DocumentStatus = 'active',
  ) {
    const unique = [...new Set(stagedIds)];
    const staged = await this.stagedFiles.find({
      where: { id: In(unique), uploader_id: uploaderId },
    });
    if (staged.length !== unique.length)
      throw new BadRequestException('Unknown staged file');

    // Keep the order the form showed them in.
    const byId = new Map(staged.map((s) => [s.id, s]));
    const rows = unique.map((id) => {
      const s = byId.get(id)!;
      return this.documents.create({
        upload_id: uploadId,
        file_url: s.file_url,
        preview_url: s.preview_url,
        original_name: s.original_name,
        file_size_kb: s.file_size_kb,
        status,
      });
    });

    const saved = await this.documents.save(rows);
    await this.stagedFiles.delete(unique);
    return saved.map((d) => ({
      id: d.id,
      upload_id: d.upload_id,
      file_url: d.file_url,
      preview_url: d.preview_url,
      original_name: d.original_name,
      file_size_kb: d.file_size_kb,
      status: d.status,
    }));
  }

  // ─── Upload ────────────────────────────────────────────────────────────────

  async uploadMany(
    uploaderId: string,
    dto: CreateDocumentDto,
    files: Express.Multer.File[],
  ) {
    // Files arrive one of two ways: staged ahead of time (the upload form sends
    // each file as it's picked) or in this multipart request.
    const stagedIds = dto.staged_file_ids ?? [];
    if (!files?.length && !stagedIds.length)
      throw new BadRequestException('No files provided');
    const major = await this.loadMajor(dto.major_id);
    this.assertDocType(major, dto.doc_type);
    const audience = await this.resolveAudience(major, dto.audience ?? []);

    const firstName =
      files?.[0]?.originalname ??
      (await this.stagedFiles.findOne({ where: { id: stagedIds[0] } }))
        ?.original_name ??
      'Untitled';
    const title = this.resolveTitle(dto.title, firstName);

    // 1. One uploads row for the entire batch
    let upload: Upload;
    try {
      upload = await this.uploads.save(
        this.uploads.create({
          uploader_id: uploaderId,
          major_id: dto.major_id,
          subject_id: dto.subject_id ?? null,
          title,
          description: dto.description?.trim() || null,
          doc_type: dto.doc_type,
          year_level: dto.year_level,
          academic_year: dto.academic_year ?? null,
          ...audience,
          expires_at: dto.expires_at ? new Date(dto.expires_at) : null,
          status: 'pending',
        }),
      );
    } catch (err) {
      if (pgCode(err) === '23503')
        throw new BadRequestException('Invalid major_id or subject_id');
      throw new InternalServerErrorException('Failed to create upload record');
    }

    // 2. One documents row per file — from the staged rows, from the multipart
    // files, or both.
    const fileResults: unknown[] = stagedIds.length
      ? await this.claimStagedFiles(upload.id, uploaderId, stagedIds)
      : [];
    for (const file of files ?? []) {
      fileResults.push(
        await this.uploadFile(upload.id, uploaderId, dto.major_id, file),
      );
    }

    return { upload_id: upload.id, files: fileResults };
  }

  private async uploadFile(
    uploadId: string,
    uploaderId: string,
    majorId: string,
    file: Express.Multer.File,
    status: DocumentStatus = 'active',
  ) {
    const ext = file.originalname.split('.').pop();
    const baseKey = `${majorId}/${uploaderId}/${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const key = `${baseKey}.${ext}`;

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

    const { url: previewUrl, key: previewKey } = await this.buildPreview(
      baseKey,
      file,
    );

    try {
      const doc = await this.documents.save(
        this.documents.create({
          upload_id: uploadId,
          file_url: fileUrl,
          preview_url: previewUrl,
          original_name: file.originalname,
          file_size_kb: Math.round(file.size / 1024),
          status,
        }),
      );
      return {
        id: doc.id,
        upload_id: doc.upload_id,
        file_url: doc.file_url,
        preview_url: doc.preview_url,
        original_name: doc.original_name,
        file_size_kb: doc.file_size_kb,
        status: doc.status,
      };
    } catch {
      await this.storage.remove([
        `${BUCKETS.DOCUMENTS}/${key}`,
        ...(previewKey ? [`${BUCKETS.DOCUMENTS}/${previewKey}`] : []),
      ]);
      throw new InternalServerErrorException('Failed to save document record');
    }
  }

  private resolveTitle(title: string | undefined, originalName: string) {
    const trimmed = title?.trim();
    if (trimmed) return trimmed;
    return originalName.replace(/\.[^.]+$/, '');
  }

  /**
   * Reshape an Upload entity (+ relations) into the shape the frontend expects,
   * matching the old Supabase nested-select output.
   *
   * `viewer` decides which files come back. A file awaiting review — or turned
   * down — belongs to its uploader and to admins; nobody else learns it exists.
   * Pass no viewer where the caller has already filtered in SQL (the feed).
   */
  private toFeedShape(
    u: Upload,
    viewer?: { id: string; role: string },
  ) {
    return {
      id: u.id,
      title: u.title,
      description: u.description,
      doc_type: u.doc_type,
      year_level: u.year_level,
      academic_year: u.academic_year,
      audience: u.audience ?? [],
      expires_at: u.expires_at,
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
        ? { id: u.subject.id, name: u.subject.name, acronym: u.subject.acronym }
        : null,
      documents: this.visibleFiles(u, viewer).map((d) => ({
        id: d.id,
        file_url: d.file_url,
        preview_url: d.preview_url,
        file_size_kb: d.file_size_kb,
        original_name: d.original_name,
        // 'active' for everything the public can see; the uploader also gets
        // 'pending'/'rejected' rows so the page can mark them.
        status: d.status,
        rejection_reason: d.rejection_reason,
      })),
    };
  }

  /** Files of `u` that `viewer` may see — see toFeedShape. */
  private visibleFiles(u: Upload, viewer?: { id: string; role: string }) {
    const files = u.documents ?? [];
    const privileged =
      !!viewer && (viewer.id === u.uploader_id || viewer.role === 'admin');
    return privileged ? files : files.filter((d) => d.status === 'active');
  }

  // ─── List ──────────────────────────────────────────────────────────────────

  async findAll(query: QueryDocumentsDto, viewerId: string) {
    const viewer = await this.getViewer(viewerId);

    const qb = this.uploads
      .createQueryBuilder('u')
      .leftJoinAndSelect('u.uploader', 'uploader')
      .leftJoinAndSelect('u.major', 'major')
      .leftJoinAndSelect('u.subject', 'subject')
      // A pending file is invisible in the feed even to its own uploader — the
      // count on a feed card should say what the public can actually open. The
      // uploader sees it, marked, on the detail page.
      .leftJoinAndSelect('u.documents', 'documents', 'documents.status = :ok', {
        ok: 'active',
      })
      .where('u.status = :status', { status: 'active' })
      // Filtered in SQL, not after the fact, so paging stays correct. An upload
      // reaches zero approved files only if its last approved one was deleted
      // while a pending file remained; it comes back the moment that file is
      // cleared. Without this it would list as an empty folder.
      .andWhere(
        'exists (select 1 from documents d where d.upload_id = u.id and d.status = :ok)',
      )
      .orderBy('u.uploaded_at', 'DESC');

    // Restrict to uploads this viewer is allowed to see. Listing one's own
    // uploads (uploader_id === viewer, the dashboard) keeps expired docs; the
    // browse feed hides them from everyone, uploader included.
    const includeExpired = !!query.uploader_id && query.uploader_id === viewerId;
    this.applyVisibility(qb, viewer, includeExpired);

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
      // Titles are short, so a keyword often only appears in the description —
      // both are searched, backed by the trigram indexes on each column.
      qb.andWhere('(u.title ILIKE :search OR u.description ILIKE :search)', {
        search: `%${query.search}%`,
      });
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

  async findOne(uploadId: string, viewerId: string) {
    const upload = await this.uploads
      .createQueryBuilder('u')
      .leftJoinAndSelect('u.uploader', 'uploader')
      .leftJoinAndSelect('u.major', 'major')
      .leftJoinAndSelect('u.subject', 'subject')
      .leftJoinAndSelect('u.documents', 'documents')
      .where('u.id = :id', { id: uploadId })
      .andWhere('u.status = :status', { status: 'active' })
      .getOne();

    if (!upload) throw new NotFoundException('Document not found');

    // Enforce audience restriction. Return 404 (not 403) so a restricted doc's
    // existence isn't revealed to users outside its audience.
    const viewer = await this.getViewer(viewerId);
    if (!this.canView(upload, viewer))
      throw new NotFoundException('Document not found');

    return this.toFeedShape(upload, viewer);
  }

  // ─── Update own upload (metadata only) ──────────────────────────────────────

  async update(uploadId: string, userId: string, dto: UpdateDocumentDto) {
    const upload = await this.uploads.findOne({
      where: { id: uploadId },
      // major_id + audience are needed to re-resolve the audience when only one
      // of them is being edited; expires_at to tell an unchanged past expiry
      // from one being moved into the past.
      select: {
        id: true,
        uploader_id: true,
        status: true,
        major_id: true,
        audience: true,
        expires_at: true,
      },
    });

    if (!upload) throw new NotFoundException('Upload not found');
    if (upload.uploader_id !== userId)
      throw new ForbiddenException('Not your upload');

    // Build the patch — only fields that were sent.
    const patch: Partial<Upload> = {};
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.description !== undefined)
      patch.description = dto.description?.trim() || null;
    if (dto.doc_type !== undefined) patch.doc_type = dto.doc_type;
    if (dto.major_id !== undefined) patch.major_id = dto.major_id;
    if (dto.subject_id !== undefined) patch.subject_id = dto.subject_id ?? null;
    if (dto.year_level !== undefined) patch.year_level = dto.year_level;
    if (dto.academic_year !== undefined)
      patch.academic_year = dto.academic_year ?? null;
    // The audience depends on the major (a language course clears it), so any
    // edit to either re-resolves both axes from the resulting values.
    if (
      dto.major_id !== undefined ||
      dto.doc_type !== undefined ||
      dto.audience !== undefined
    ) {
      const major = await this.loadMajor(dto.major_id ?? upload.major_id);
      if (dto.doc_type !== undefined) this.assertDocType(major, dto.doc_type);
      if (dto.major_id !== undefined || dto.audience !== undefined) {
        Object.assign(
          patch,
          await this.resolveAudience(
            major,
            dto.audience ?? upload.audience ?? [],
          ),
        );
      }
    }
    if (dto.expires_at !== undefined) {
      const next = dto.expires_at ? new Date(dto.expires_at) : null;
      if (next && Number.isNaN(next.getTime()))
        throw new BadRequestException('Invalid expires_at');
      // An upload that has already expired keeps its past date when the owner
      // edits something else; only a CHANGE has to land in the future.
      const current = upload.expires_at ? new Date(upload.expires_at) : null;
      const changed =
        (next?.getTime() ?? null) !== (current?.getTime() ?? null);
      if (changed && next && next.getTime() <= Date.now())
        throw new BadRequestException('expires_at must be in the future');
      patch.expires_at = next;
    }

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

    return { message: 'Upload updated' };
  }

  /** Add files to an existing upload (uploader only). */
  async addFiles(
    uploadId: string,
    userId: string,
    files: Express.Multer.File[],
    stagedFileIds: string[] = [],
  ) {
    // Same two routes in as a new upload: staged ahead of time by the form, or
    // sent with this request.
    if (!files?.length && !stagedFileIds.length)
      throw new BadRequestException('No files provided');

    const upload = await this.uploads.findOne({
      where: { id: uploadId },
      select: { id: true, uploader_id: true, major_id: true, status: true },
    });

    if (!upload) throw new NotFoundException('Upload not found');
    if (upload.uploader_id !== userId)
      throw new ForbiddenException('Not your upload');

    // A file added to an ALREADY-APPROVED upload has never been reviewed, so it
    // lands pending and stays hidden from everyone but its uploader. The upload
    // keeps its own status either way — hiding one new file is what stops an
    // approved document from leaving the feed over a single attachment.
    //
    // On an upload that is still pending or rejected, the files are 'active':
    // the upload's own review below covers everything in it as a group.
    const fileStatus: DocumentStatus =
      upload.status === 'active' ? 'pending' : 'active';

    const results: unknown[] = stagedFileIds.length
      ? await this.claimStagedFiles(uploadId, userId, stagedFileIds, fileStatus)
      : [];
    for (const file of files ?? []) {
      results.push(
        await this.uploadFile(
          uploadId,
          userId,
          upload.major_id,
          file,
          fileStatus,
        ),
      );
    }

    // Editing sends the upload back for review.
    if (upload.status !== 'active') {
      await this.uploads.update(
        { id: uploadId },
        { status: 'pending', rejection_reason: null },
      );
    }

    return { files: results, needs_review: fileStatus === 'pending' };
  }

  /**
   * Remove one file from an upload (uploader only).
   *
   * Removing the LAST file takes the upload with it: an upload with no files
   * is a title pointing at nothing — it would still list in the feed and open
   * to an empty detail page. Callers get `upload_deleted` so they can navigate
   * away instead of refetching a row that no longer exists.
   */
  async removeFile(fileId: string, userId: string) {
    const file = await this.documents.findOne({
      where: { id: fileId },
      select: { id: true, file_url: true, preview_url: true, upload_id: true },
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

    // Delegated rather than inlined so there is one path that tears an upload
    // down — it sweeps every object key and lets the FK cascade clear the rows.
    if (count <= 1) {
      await this.delete(file.upload_id, userId);
      return {
        message: 'Upload deleted',
        upload_deleted: true,
        upload_id: file.upload_id,
      };
    }

    const keys = [file.file_url, file.preview_url]
      .map((url) => this.storage.extractKey(url))
      .filter((k): k is string => k !== null);
    if (keys.length) await this.storage.remove(keys);

    try {
      await this.documents.delete({ id: fileId });
    } catch {
      throw new InternalServerErrorException('Failed to remove file');
    }

    return {
      message: 'File removed',
      upload_deleted: false,
      upload_id: file.upload_id,
    };
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
      select: { file_url: true, preview_url: true },
    });

    const keys = files
      .flatMap((f) => [f.file_url, f.preview_url])
      .map((url) => this.storage.extractKey(url))
      .filter((k): k is string => k !== null);
    if (keys.length) await this.storage.remove(keys);

    // CASCADE deletes documents
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
      description: u.description,
      doc_type: u.doc_type,
      year_level: u.year_level,
      academic_year: u.academic_year,
      status: u.status,
      rejection_reason: u.rejection_reason,
      rejected_at: u.rejected_at,
      uploaded_at: u.uploaded_at,
      // The dashboard edits from this list, so it has to carry everything the
      // edit form writes back — a missing field would be read as "cleared" and
      // saved over the top of the real value.
      audience: u.audience ?? [],
      expires_at: u.expires_at,
      subjects: u.subject ? { id: u.subject.id, name: u.subject.name } : null,
      majors: u.major ? { id: u.major.id, acronym: u.major.acronym } : null,
      documents: (u.documents ?? []).map((d) => ({
        id: d.id,
        original_name: d.original_name,
        file_size_kb: d.file_size_kb,
      })),
    }));
  }
}
