import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Repository } from 'typeorm';
import { AudienceEntry, Upload } from './entities/upload.entity';
import { DocumentFile } from './entities/document.entity';
import { UploadPin } from './entities/upload-pin.entity';
import { StagedFile } from './entities/staged-file.entity';
import { User } from '../users/entities/user.entity';
import { Major } from '../majors/entities/major.entity';
import { BUCKETS, StorageService } from '../storage/storage.service';
import { OfficeConvertService } from '../storage/office-convert.service';
import { pgCode } from '../../common/utils/pg-error';
import { LANGUAGE_MAJOR_ACRONYMS } from './constants/majors';
import { decodeUploadName } from './utils/upload-name';
import { yearLevelsForMajor } from './utils/year-levels';
import {
  CreateDocumentDto,
  DEPARTMENT_DOC_TYPES,
  DocType,
  LANGUAGE_DOC_TYPES,
} from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { QueryDocumentsDto } from './dto/query-documents.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { ImageOptimizeService } from '../storage/image-optimize.service';
import { UploadQuotaService } from '../../common/rate-limit/upload-quota.service';
import { ClamAvService } from '../../common/security/clamav.service';
import {
  isProcessableImage,
  validateFileContent,
  type ValidationOutcome,
} from './utils/file-signature';
import { randomUUID } from 'crypto';

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
    private readonly notifications: NotificationsService,
    @InjectRepository(Major)
    private readonly majors: Repository<Major>,
    @InjectRepository(UploadPin)
    private readonly uploadPins: Repository<UploadPin>,
    private readonly storage: StorageService,
    private readonly officeConvert: OfficeConvertService,
    private readonly images: ImageOptimizeService,
    private readonly quota: UploadQuotaService,
    private readonly clamav: ClamAvService,
  ) {}

  private readonly securityLog = new Logger('UploadSecurity');

  /**
   * Confirm a file is what it claims to be, and bound it if it is an image.
   *
   * Runs before anything is written, so a rejected file never reaches storage.
   * The client is told only that the file was unsupported — the detected type
   * and the reason go to the log, where they are useful, rather than to the
   * uploader, who would use them to find what does get through.
   */
  private async vetFile(
    uploaderId: string,
    originalName: string,
    file: Express.Multer.File,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const verdict: ValidationOutcome = validateFileContent(
      originalName,
      file.buffer,
    );

    if (!verdict.ok) {
      this.logRejection(uploaderId, file, verdict);
      throw new BadRequestException('Unsupported or invalid file type.');
    }

    // Scanned here: after the bytes are confirmed to be a type we accept, and
    // before anything is written or re-encoded. The ORIGINAL buffer is what
    // goes to clamd — that is what the uploader sent, and for everything except
    // images it is also exactly what will be stored.
    const scan = await this.clamav.scan(file.buffer);

    if (scan.status === 'infected') {
      this.securityLog.warn(
        `upload rejected user=${uploaderId} size=${file.size} ` +
          `declared=${file.mimetype} reason=malware signature=${scan.signature}`,
      );
      // The signature name stays in the log. Telling an uploader which rule
      // fired is a tuning hint for anyone probing the scanner, and means
      // nothing to a student who picked the wrong file.
      throw new BadRequestException(
        'This file was rejected by the malware scanner.',
      );
    }

    if (scan.status === 'unavailable') {
      // Fail closed. An unscanned upload would be indistinguishable from a
      // scanned one once stored, so "the scanner was down" must not quietly
      // become "the file is fine". The operator sees this at ERROR; the
      // uploader sees a retryable 503.
      this.securityLog.error(
        `upload refused user=${uploaderId} size=${file.size} ` +
          `reason=scanner-unavailable detail=${scan.reason}`,
      );
      throw new ServiceUnavailableException(
        'File scanning is temporarily unavailable. Please try again shortly.',
      );
    }

    if (isProcessableImage(verdict.kind)) {
      const optimized = await this.images.optimizeOrOriginal(
        file.buffer,
        verdict.kind as 'jpeg' | 'png',
      );
      if (optimized) {
        return { buffer: optimized.buffer, contentType: optimized.contentType };
      }
    }

    // Everything else is stored byte-for-byte. A student's PDF must come back
    // exactly as submitted; the detected MIME is used rather than the declared
    // one so the stored object's Content-Type reflects the actual bytes.
    return {
      buffer: file.buffer,
      contentType: verdict.detectedMime ?? 'application/octet-stream',
    };
  }

  /**
   * One line per refused upload: who, how big, what they said it was, what it
   * actually was, and why it was refused. No filename, no bytes, no token.
   */
  private logRejection(
    uploaderId: string,
    file: Express.Multer.File,
    verdict: ValidationOutcome,
  ) {
    this.securityLog.warn(
      `upload rejected user=${uploaderId} size=${file.size} ` +
        `declared=${file.mimetype} detected=${verdict.detectedMime ?? 'none'} ` +
        `reason=${verdict.reason ?? 'unknown'}`,
    );
  }

  /**
   * Reserve quota for a batch, or refuse it.
   *
   * Throws the 429 with Retry-After the spec calls for. Reserved up front so a
   * batch is accepted or rejected as a whole, and refunded by the caller if the
   * write then fails.
   */
  private async reserveQuota(uploaderId: string, bytes: number) {
    const decision = await this.quota.consume(uploaderId, bytes);
    if (!decision.allowed) {
      this.securityLog.warn(
        `upload quota exceeded user=${uploaderId} requested=${bytes} ` +
          `remaining=${decision.remaining} limit=${decision.limit}`,
      );
      throw new HttpException(
        {
          success: false,
          message: 'Upload quota exceeded. Try again later.',
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
        },
        HttpStatus.TOO_MANY_REQUESTS,
        // Surfaced as a header by the filter below; also in the body for
        // clients that cannot read headers cross-origin.
        { cause: { retryAfter: decision.retryAfterSeconds } },
      );
    }
    return decision;
  }

  /**
   * A storage key that carries no user input.
   *
   * Was `${Date.now()}-${Math.random()}`: guessable, and it ended in the
   * uploader's own filename. A v4 UUID has 122 bits of CSPRNG entropy and
   * nothing of the original name — which now lives only in `original_name`.
   */
  private buildKey(prefix: string, ext: string | null): string {
    const safeExt = (ext ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 8);
    return safeExt
      ? `${prefix}/${randomUUID()}.${safeExt}`
      : `${prefix}/${randomUUID()}`;
  }

  /**
   * Restrict a feed query to uploads the viewer is allowed to see. A viewer
   * sees an upload when it's public, they uploaded it, they're an admin, or
   * their department/year matches the upload's audience rule. Applied as an
   * AND on the query builder (`u` is the uploads alias). `paramPrefix` keeps
   * bound params unique if this is ever called twice on one builder.
   */
  private applyVisibility(
    qb: import('typeorm').SelectQueryBuilder<Upload>,
    viewer: {
      id: string;
      role: string;
      major_id: string | null;
      year_level: number | null;
    },
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
    // Hiding is the uploader's own switch, so it behaves like expiry: gone from
    // the feed for everyone, still listed when they browse their own uploads.
    const notHidden = '(:includeExpired OR u.hidden_at IS NULL)';

    if (viewer.role === 'admin') {
      // Admins bypass the audience restriction (for moderation) but not expiry.
      qb.andWhere(notExpired, { includeExpired });
      qb.andWhere(notHidden, { includeExpired });
      return;
    }

    // Not expired AND the viewer either uploaded it or their own (department,
    // year) is one of the pairs the audience lists. An empty array is no
    // restriction — which is also what language-course uploads always store,
    // since every student takes those.
    qb.andWhere(
      `(
        ${notExpired}
        AND ${notHidden}
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
    viewer: {
      id: string;
      role: string;
      major_id: string | null;
      year_level: number | null;
    },
  ): boolean {
    if (viewer.role === 'admin') return true;
    if (upload.uploader_id === viewer.id) return true;
    // Expired uploads are hidden from everyone but the uploader/admins.
    if (upload.expires_at && new Date(upload.expires_at) <= new Date())
      return false;
    // Same for hidden ones — the two early returns above keep owner/admin access.
    if (upload.hidden_at) return false;
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
    const sourceName = decodeUploadName(file.originalname);
    if (!this.officeConvert.canConvert(sourceName))
      return { url: null, key: null };

    const pdf = await this.officeConvert.toPdf(file.buffer, sourceName);
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

    const originalName = decodeUploadName(file.originalname);

    // Charged against the bytes RECEIVED, not the bytes kept, and charged
    // before anything expensive happens. Sharp can shrink a 20 MB photo to
    // 200 KB, so billing the stored size would leave the exact abuse this
    // exists for — pushing volume at the server — effectively unbounded.
    // Reserving first also means a refusal costs no decode. A file rejected
    // by vetting stays charged on purpose: otherwise invalid bytes would be
    // free to send without limit.
    const ingressBytes = file.buffer?.length ?? file.size ?? 0;
    await this.reserveQuota(uploaderId, ingressBytes);

    // The bytes decide what this is, and an image is bounded here — both before
    // anything is written, so a refusal costs no storage.
    const { buffer, contentType } = await this.vetFile(
      uploaderId,
      originalName,
      file,
    );

    const ext = originalName.includes('.')
      ? originalName.split('.').pop()!
      : null;
    const key = this.buildKey(`staged/${uploaderId}`, ext);
    const baseKey = key.replace(/\.[^.]*$/, '');

    let fileUrl: string;
    try {
      fileUrl = await this.storage.upload(
        BUCKETS.DOCUMENTS,
        key,
        buffer,
        contentType,
      );
    } catch {
      await this.quota.refund(uploaderId, ingressBytes);
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
          original_name: originalName,
          // The stored size, not the uploaded one — they differ once an image
          // has been re-encoded, and every consumer wants what is on disk.
          file_size_kb: Math.round(buffer.length / 1024),
        }),
      );
      return {
        id: staged.id,
        // Signed like every other document URL: the upload form shows the
        // staged file back as a thumbnail, and the bucket is private, so the
        // stored URL would 403. The caller is the uploader by construction.
        //
        // Inline only for images, and only because Sharp re-encoded them —
        // those bytes are ours. Anything else keeps the attachment default,
        // so a staged PDF cannot be made to render on the storage origin.
        file_url: await this.signOrFallback(
          `${BUCKETS.DOCUMENTS}/${staged.storage_key}`,
          staged.file_url,
          staged.original_name,
          /\.(jpe?g|png)$/i.test(staged.storage_key ?? ''),
        ),
        preview_url: staged.preview_key
          ? await this.signOrFallback(
              `${BUCKETS.DOCUMENTS}/${staged.preview_key}`,
              staged.preview_url,
              staged.original_name,
              true,
            )
          : staged.preview_url,
        original_name: staged.original_name,
        file_size_kb: staged.file_size_kb,
      };
    } catch {
      // Row failed: take the objects back out and return the budget, so a
      // failed stage leaves neither an orphan nor a spent quota.
      await this.storage.remove(
        this.stagedObjectPaths({ storage_key: key, preview_key: preview.key }),
      );
      await this.quota.refund(uploaderId, ingressBytes);
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
        // Qualified with the bucket on the way across: staged_files stores a
        // BARE key (stagedObjectPaths prepends the bucket), while documents
        // stores a full "<bucket>/<key>" ref. Copying verbatim would write an
        // unresolvable ref and every staged upload would fail to download.
        storage_key: `${BUCKETS.DOCUMENTS}/${s.storage_key}`,
        preview_key: s.preview_key
          ? `${BUCKETS.DOCUMENTS}/${s.preview_key}`
          : null,
        preview_url: s.preview_url,
        original_name: s.original_name,
        file_size_kb: s.file_size_kb,
        status,
      });
    });

    const saved = await this.documents.save(rows);
    await this.stagedFiles.delete(unique);
    // Signed on the way out, like every other read: the bucket is private, so
    // the stored URL would 403 if the caller used it. The caller is the
    // uploader by construction here.
    return Promise.all(
      saved.map(async (d) => ({
        id: d.id,
        upload_id: d.upload_id,
        file_url: await this.signOrFallback(
          d.storage_key,
          d.file_url,
          d.original_name,
        ),
        preview_url: await this.signOrFallback(
          d.preview_key,
          d.preview_url,
          d.original_name,
          true,
        ),
        original_name: d.original_name,
        file_size_kb: d.file_size_kb,
        status: d.status,
      })),
    );
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
      (decodeUploadName(files?.[0]?.originalname) ||
        (await this.stagedFiles.findOne({ where: { id: stagedIds[0] } }))
          ?.original_name) ??
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

    /**
     * Tell the people who have to review it.
     *
     * Last, and not awaited for its result: the upload is already saved and the
     * student is waiting on this response. A reviewer who is not told still has
     * the queue in front of them; a student who sees an error because a
     * notification failed has lost their upload for no reason.
     */
    const uploader = await this.users.findOne({
      where: { id: uploaderId },
      select: { first_name: true, last_name: true },
    });
    const uploaderName =
      `${uploader?.first_name ?? ''} ${uploader?.last_name ?? ''}`.trim() ||
      'A student';

    void this.notifications.createForReviewers({
      major_id: dto.major_id,
      type: 'document_pending',
      message: `${uploaderName} submitted "${title}" for review.`,
      key: 'documentPending',
      params: { name: uploaderName, title },
      ref_id: upload.id,
      ref_type: 'upload',
      except_user_id: uploaderId,
    });

    return { upload_id: upload.id, files: fileResults };
  }

  private async uploadFile(
    uploadId: string,
    uploaderId: string,
    majorId: string,
    file: Express.Multer.File,
    status: DocumentStatus = 'active',
  ) {
    const originalName = decodeUploadName(file.originalname);

    // Ingress bytes, reserved before the decode — see stageFile.
    const ingressBytes = file.buffer?.length ?? file.size ?? 0;
    await this.reserveQuota(uploaderId, ingressBytes);

    // Same gate as the staged path — this endpoint accepts files directly, so
    // it cannot rely on staging having vetted them.
    const { buffer, contentType } = await this.vetFile(
      uploaderId,
      originalName,
      file,
    );

    const ext = originalName.includes('.')
      ? originalName.split('.').pop()!
      : null;
    const key = this.buildKey(`${majorId}/${uploaderId}`, ext);
    const baseKey = key.replace(/\.[^.]*$/, '');

    let fileUrl: string;
    try {
      fileUrl = await this.storage.upload(
        BUCKETS.DOCUMENTS,
        key,
        buffer,
        contentType,
      );
    } catch {
      await this.quota.refund(uploaderId, ingressBytes);
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
          // The canonical refs. file_url stays for legacy readers; everything
          // that grants access reads these.
          storage_key: `${BUCKETS.DOCUMENTS}/${key}`,
          preview_key: previewKey ? `${BUCKETS.DOCUMENTS}/${previewKey}` : null,
          preview_url: previewUrl,
          original_name: originalName,
          file_size_kb: Math.round(buffer.length / 1024),
          status,
        }),
      );
      // Signed on the way out — see claimStagedFiles.
      return {
        id: doc.id,
        upload_id: doc.upload_id,
        file_url: await this.signOrFallback(
          doc.storage_key,
          doc.file_url,
          doc.original_name,
        ),
        preview_url: await this.signOrFallback(
          doc.preview_key,
          doc.preview_url,
          doc.original_name,
          true,
        ),
        original_name: doc.original_name,
        file_size_kb: doc.file_size_kb,
        status: doc.status,
      };
    } catch {
      await this.storage.remove([
        `${BUCKETS.DOCUMENTS}/${key}`,
        ...(previewKey ? [`${BUCKETS.DOCUMENTS}/${previewKey}`] : []),
      ]);
      await this.quota.refund(uploaderId, ingressBytes);
      throw new InternalServerErrorException('Failed to save document record');
    }
  }

  // ─── Authorised file access ───────────────────────────────────────────────

  /**
   * Mint a short-lived URL for one file, or refuse.
   *
   * This is the ONLY way a document object is reachable now that the bucket is
   * private, which makes it the single place the audience rules have to hold.
   * The order below is deliberate and load-bearing:
   *
   *   load the file → load its upload → authorise → THEN sign
   *
   * Signing before authorising would mint a working URL for a caller about to
   * be refused, and a URL is a bearer token: once created it cannot be recalled
   * for its lifetime. Nothing in this method talks to storage until every check
   * has passed.
   *
   * Refusals are 404, not 403 — matching findOne(), so that asking about a
   * document you may not see cannot confirm it exists.
   */
  async signFileAccess(
    fileId: string,
    viewerId: string,
    variant: 'download' | 'preview',
  ): Promise<{
    url: string;
    expires_in: number;
    original_name: string | null;
  }> {
    const file = await this.documents.findOne({
      where: { id: fileId },
      relations: { upload: true },
    });
    if (!file) throw new NotFoundException('File not found');

    const upload = file.upload;
    if (!upload) throw new NotFoundException('File not found');

    const viewer = await this.getViewer(viewerId);

    // 1. May this viewer see the parent upload at all? Audience, expiry and
    //    hidden state all live in canView, reused rather than restated.
    if (!this.canView(upload, viewer))
      throw new NotFoundException('File not found');

    // 2. Is the upload itself published? A pending or rejected upload belongs
    //    to its uploader and to admins until a moderator clears it.
    const isOwner = upload.uploader_id === viewer.id;
    const isAdmin = viewer.role === 'admin';
    if (upload.status !== 'active' && !isOwner && !isAdmin) {
      throw new NotFoundException('File not found');
    }

    // 3. And this individual file — one added to an approved upload is pending
    //    on its own, and a hidden file is the uploader's business only.
    if ((file.status !== 'active' || file.hidden_at) && !isOwner && !isAdmin) {
      throw new NotFoundException('File not found');
    }

    const ref = variant === 'preview' ? file.preview_key : file.storage_key;
    if (!ref) {
      // A row written before the backfill, or an office file with no preview.
      throw new NotFoundException(
        variant === 'preview' ? 'No preview for this file' : 'File not found',
      );
    }

    // Only now does storage get involved.
    const url = await this.storage.signedUrlForRef(ref, {
      downloadName: file.original_name,
      // A preview is a PDF this server generated, so it is safe to show in
      // place. An original is whatever a student uploaded and is always an
      // attachment — an inline HTML or SVG would otherwise run as a page.
      inline: variant === 'preview',
    });

    if (!url) throw new NotFoundException('File not found');

    return {
      url,
      expires_in: this.storage.signedUrlTtl,
      original_name: file.original_name,
    };
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
  private async toFeedShape(u: Upload, viewer?: { id: string; role: string }) {
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
      // Always 'active' in the public feed, which filters on it. Meaningful
      // only when listing your own uploads with ?status=… — see findAll.
      status: u.status,
      /** Non-null when the uploader has hidden it. Only they and admins see it. */
      hidden_at: u.hidden_at,
      /**
       * Non-null when THIS viewer has pinned it. Queries join `pins` filtered
       * to the viewer, so there is at most one — nobody sees another's pin.
       */
      pinned_at: u.pins?.[0]?.pinned_at ?? null,
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
        ? {
            id: u.subject.id,
            name: u.subject.name,
            acronym: u.subject.acronym,
            semester: u.subject.semester,
          }
        : null,
      documents: await Promise.all(
        this.visibleFiles(u, viewer).map(async (d) => ({
          id: d.id,
          // Signed here rather than stored: the bucket is private, so a URL is a
          // short-lived grant rather than an address. This row has already been
          // through the audience filter, so signing it is authorised by the same
          // decision that returned it. Presigning is a local HMAC — no network —
          // so a page of two dozen files costs microseconds.
          //
          // Click-to-download uses GET /documents/files/:id/download instead: it
          // re-authorises, mints a fresh URL, and sets Content-Disposition.
          file_url: await this.signOrFallback(
            d.storage_key,
            d.file_url,
            d.original_name,
          ),
          preview_url: await this.signOrFallback(
            d.preview_key,
            d.preview_url,
            d.original_name,
            true,
          ),
          file_size_kb: d.file_size_kb,
          original_name: d.original_name,
          // 'active' for everything the public can see; the uploader also gets
          // 'pending'/'rejected' rows so the page can mark them.
          status: d.status,
          rejection_reason: d.rejection_reason,
          /** Non-null when the uploader has hidden this file specifically. */
          hidden_at: d.hidden_at,
        })),
      ),
    };
  }

  /**
   * A usable URL for an object, preferring the canonical key.
   *
   * Rows written before the storage-key migration have only a legacy URL. That
   * URL stops working the moment the bucket goes private, so it is returned
   * only as a last resort — and the backfill in DocumentStorageKeys means it
   * should never be reached for a document.
   */
  private async signOrFallback(
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

  /** Files of `u` that `viewer` may see — see toFeedShape. */
  private visibleFiles(u: Upload, viewer?: { id: string; role: string }) {
    const files = u.documents ?? [];
    const privileged =
      !!viewer && (viewer.id === u.uploader_id || viewer.role === 'admin');
    return privileged
      ? files
      : files.filter((d) => d.status === 'active' && !d.hidden_at);
  }

  // ─── List ──────────────────────────────────────────────────────────────────

  async findAll(query: QueryDocumentsDto, viewerId: string) {
    const viewer = await this.getViewer(viewerId);
    // Listing your own uploads unlocks the non-active statuses (and, below,
    // expired ones): it is your record of what you posted, not a public feed.
    const ownList = !!query.uploader_id && query.uploader_id === viewerId;

    const qb = this.uploads
      .createQueryBuilder('u')
      .leftJoinAndSelect('u.uploader', 'uploader')
      .leftJoinAndSelect('u.major', 'major')
      .leftJoinAndSelect('u.subject', 'subject')
      // A pending file is invisible in the feed even to its own uploader — the
      // count on a feed card should say what the public can actually open. The
      // uploader sees it, marked, on the detail page.
      .leftJoinAndSelect(
        'u.documents',
        'documents',
        'documents.status = :ok AND documents.hidden_at IS NULL',
        { ok: 'active' },
      )
      // Non-active statuses are only honoured when you are listing your OWN
      // uploads. Otherwise `?status=pending` would expose every unreviewed
      // upload in the institute to anyone who guessed the parameter.
      //
      // On your own list, NO status means every status — your dashboard's "All
      // statuses" filter sends nothing, and defaulting to 'active' there hid
      // your own pending and rejected uploads from the one screen that exists
      // to show you what happened to them.
      .where(
        ownList && !query.status
          ? 'u.status IN (:...statuses)'
          : 'u.status = :status',
        ownList && !query.status
          ? { statuses: ['active', 'pending', 'rejected'] }
          : { status: ownList ? query.status : 'active' },
      )
      // Filtered in SQL, not after the fact, so paging stays correct. An upload
      // reaches zero approved files only if its last approved one was deleted
      // while a pending file remained; it comes back the moment that file is
      // cleared. Without this it would list as an empty folder.
      .andWhere(
        'exists (select 1 from documents d where d.upload_id = u.id and d.status = :ok and d.hidden_at is null)',
      )
      // Filtered to the viewer, so it can only ever attach their own pin: the
      // join both feeds `pinned_at` back to the client and drives the sort.
      .leftJoinAndSelect('u.pins', 'pin', 'pin.user_id = :viewerId', {
        viewerId,
      })
      .orderBy('u.uploaded_at', 'DESC');

    // Restrict to uploads this viewer is allowed to see. Listing one's own
    // uploads (uploader_id === viewer, the dashboard) keeps expired docs; the
    // browse feed hides them from everyone, uploader included.
    const includeExpired = ownList;

    // Your pins lead every listing you look at — the feed, a subject page.
    // Because the join is filtered to you, this reorders nothing for anyone
    // else: two people opening the same subject see the same documents in the
    // order each of them chose.
    //
    // orderBy(), not addOrderBy(): the builder already sorts by uploaded_at, and
    // appending would leave the pin as a tie-breaker that never breaks a tie.
    //
    // ?sort=date opts out. The owner's dashboard is a record of what they
    // uploaded and when, and a pinned row jumping to the top of it makes the
    // date column look unsorted. The pin JOIN stays either way — it also feeds
    // `pinned_at` back to the client for the pin/unpin menu.
    if (query.sort === 'date') {
      qb.orderBy('u.uploaded_at', 'DESC');
    } else {
      qb.orderBy('pin.pinned_at', 'DESC', 'NULLS LAST').addOrderBy(
        'u.uploaded_at',
        'DESC',
      );
    }
    this.applyVisibility(qb, viewer, includeExpired);

    if (query.major_id)
      qb.andWhere('u.major_id = :major_id', { major_id: query.major_id });
    if (query.subject_id)
      qb.andWhere('u.subject_id = :subject_id', {
        subject_id: query.subject_id,
      });
    // Only meaningful on your own list; applyVisibility already hides other
    // people's hidden uploads outright.
    if (query.hidden === 'true' && query.uploader_id === viewerId)
      qb.andWhere('u.hidden_at IS NOT NULL');

    // Same gate, same reason. Only reachable on the owner's own list, which is
    // also the only listing that returns expired uploads in the first place.
    if (query.expired === 'true' && query.uploader_id === viewerId)
      qb.andWhere('u.expires_at IS NOT NULL AND u.expires_at <= now()');

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
        items: await Promise.all(rows.map((u) => this.toFeedShape(u))),
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
      .leftJoinAndSelect('u.pins', 'pin', 'pin.user_id = :viewerId', {
        viewerId,
      })
      .where('u.id = :id', { id: uploadId })
      .andWhere('u.status = :status', { status: 'active' })
      .getOne();

    if (!upload) throw new NotFoundException('Document not found');

    // Enforce audience restriction. Return 404 (not 403) so a restricted doc's
    // existence isn't revealed to users outside its audience.
    const viewer = await this.getViewer(viewerId);
    if (!this.canView(upload, viewer))
      throw new NotFoundException('Document not found');

    return await this.toFeedShape(upload, viewer);
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

  /**
   * Hide or show one file (uploader only).
   *
   * Hiding the LAST visible file hides its upload too: a folder with nothing
   * visible in it is a title pointing at nothing, which is the same reason
   * `removeFile` deletes an upload when its last file goes.
   *
   * Showing a file again reverses that — a visible file inside a hidden folder
   * would still be unreachable, so the folder comes back with it. `upload_hidden`
   * in the reply tells the caller which way the folder moved.
   */
  async setFileHidden(fileId: string, userId: string, hidden: boolean) {
    const file = await this.documents.findOne({
      where: { id: fileId },
      select: { id: true, upload_id: true },
    });
    if (!file) throw new NotFoundException('File not found');

    const upload = await this.uploads.findOne({
      where: { id: file.upload_id },
      select: { id: true, uploader_id: true, hidden_at: true },
    });
    if (!upload) throw new NotFoundException('Upload not found');
    if (upload.uploader_id !== userId)
      throw new ForbiddenException('Not your upload');

    await this.documents.update(
      { id: fileId },
      { hidden_at: hidden ? new Date() : null },
    );

    // Counted AFTER the update so it reflects the state we just wrote.
    const visible = await this.documents.count({
      where: { upload_id: file.upload_id, hidden_at: IsNull() },
    });

    let uploadHidden = !!upload.hidden_at;
    if (hidden && visible === 0 && !upload.hidden_at) {
      await this.uploads.update(
        { id: file.upload_id },
        { hidden_at: new Date() },
      );
      uploadHidden = true;
    } else if (!hidden && visible > 0 && upload.hidden_at) {
      await this.uploads.update({ id: file.upload_id }, { hidden_at: null });
      uploadHidden = false;
    }

    return {
      message: hidden ? 'File hidden' : 'File visible',
      hidden,
      upload_hidden: uploadHidden,
      upload_id: file.upload_id,
    };
  }

  /**
   * Pin or unpin a document for yourself. Any document you can open may be
   * pinned, not just your own — the pin is a bookmark on your copy of the
   * listing and is invisible to everyone else.
   *
   * Gated on canView rather than ownership, so pinning can't be used to probe
   * for restricted or hidden uploads: what you can't read, you can't pin.
   */
  async setPinned(uploadId: string, userId: string, pinned: boolean) {
    const upload = await this.uploads.findOne({ where: { id: uploadId } });

    // 404 rather than 403 for an upload outside your audience, matching
    // findOne — a pin must not reveal that a document exists.
    if (!upload || upload.status !== 'active')
      throw new NotFoundException('Upload not found');

    const viewer = await this.getViewer(userId);
    if (!this.canView(upload, viewer))
      throw new NotFoundException('Upload not found');

    if (pinned) {
      // Re-pinning an already-pinned document is a no-op rather than an error,
      // so a double click can't 500.
      await this.uploadPins
        .createQueryBuilder()
        .insert()
        .values({ user_id: userId, upload_id: uploadId })
        .orIgnore()
        .execute();
    } else {
      await this.uploadPins.delete({ user_id: userId, upload_id: uploadId });
    }

    return { message: pinned ? 'Upload pinned' : 'Upload unpinned', pinned };
  }

  /**
   * Take a document out of circulation, or put it back. Uploader only.
   *
   * Separate from `delete` (nothing is removed) and from `update` (this does
   * not re-open review — a hidden document keeps whatever status it had).
   */
  async setHidden(uploadId: string, userId: string, hidden: boolean) {
    const upload = await this.uploads.findOne({
      where: { id: uploadId },
      select: { id: true, uploader_id: true },
    });

    if (!upload) throw new NotFoundException('Upload not found');
    if (upload.uploader_id !== userId)
      throw new ForbiddenException('Not your upload');

    await this.uploads.update(
      { id: uploadId },
      { hidden_at: hidden ? new Date() : null },
    );

    return { message: hidden ? 'Upload hidden' : 'Upload visible', hidden };
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
      subjects: u.subject
        ? {
            id: u.subject.id,
            name: u.subject.name,
            semester: u.subject.semester,
          }
        : null,
      majors: u.major ? { id: u.major.id, acronym: u.major.acronym } : null,
      documents: (u.documents ?? []).map((d) => ({
        id: d.id,
        original_name: d.original_name,
        file_size_kb: d.file_size_kb,
      })),
    }));
  }
}
