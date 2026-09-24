import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  contentDisposition,
  isSafeKeySegment,
  parseRef,
} from './storage-ref.util';

/**
 * S3-compatible object storage (MinIO in local dev, AWS S3 or any S3 API in prod).
 * Each kind of file lives in its own bucket (see BUCKETS). Objects are addressed
 * as <bucket>/<key>.
 *
 * The `documents` bucket is PRIVATE: nothing in it is reachable without a
 * presigned URL this service mints, and it only mints one after the API has
 * authorised the caller. `publicUrl()` survives for the buckets that are still
 * public (avatars, covers, logos) and for reading legacy rows — it is NOT an
 * access-control mechanism and must never be handed out for a document.
 *
 * The canonical identifier for an object is its "<bucket>/<key>" ref, stored on
 * the row as `storage_key` / `preview_key`. URLs are derived, never trusted.
 */

/** Canonical bucket names — one per file type. */
export const BUCKETS = {
  DOCUMENTS: 'documents',
  AVATARS: 'user-avatar',
  SUBJECTS: 'subject-cover',
  BOOK_COVERS: 'book-covers',
  MAJORS: 'department-logo',
} as const;

export type Bucket = (typeof BUCKETS)[keyof typeof BUCKETS];

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  /**
   * A second client bound to the PUBLIC endpoint, used only for presigning.
   *
   * An S3v4 signature covers the host, so a URL signed against the internal
   * endpoint (`http://minio:9000` inside Docker) is both unreachable from a
   * browser and unverifiable if rewritten. Uploads and deletes keep using the
   * internal client — they are server-to-server and should not leave the
   * network — while the URLs handed to clients are signed for the host those
   * clients can actually reach.
   */
  private readonly signer: S3Client;
  private readonly publicBase: string;

  constructor(private readonly config: ConfigService) {
    const endpoint = this.config.getOrThrow<string>('S3_ENDPOINT');
    // Base URL objects are served from — the S3 endpoint WITHOUT a bucket,
    // e.g. http://localhost:9000. The bucket is appended per object.
    this.publicBase = this.config
      .getOrThrow<string>('S3_PUBLIC_URL')
      .replace(/\/+$/, '');

    this.client = new S3Client({
      endpoint,
      region: this.config.get<string>('S3_REGION') ?? 'us-east-1',
      credentials: {
        accessKeyId: this.config.getOrThrow<string>('S3_ACCESS_KEY'),
        secretAccessKey: this.config.getOrThrow<string>('S3_SECRET_KEY'),
      },
      // MinIO (and most non-AWS S3s) require path-style addressing.
      forcePathStyle: true,
    });

    this.signer =
      this.publicBase === endpoint.replace(/\/+$/, '')
        ? this.client
        : new S3Client({
            endpoint: this.publicBase,
            region: this.config.get<string>('S3_REGION') ?? 'us-east-1',
            credentials: {
              accessKeyId: this.config.getOrThrow<string>('S3_ACCESS_KEY'),
              secretAccessKey: this.config.getOrThrow<string>('S3_SECRET_KEY'),
            },
            forcePathStyle: true,
          });

    const ttl = Number(this.config.get<string>('S3_SIGNED_URL_TTL_SECONDS'));
    // Clamped, not just defaulted: a misconfigured 0 would mint dead links and
    // a misconfigured 86400 would hand out a day-long bearer token.
    this.signedUrlTtlSeconds =
      Number.isFinite(ttl) && ttl >= 30 && ttl <= 600 ? ttl : 120;
  }

  /**
   * A short-lived GET URL for one object.
   *
   * Call this ONLY after the caller has been authorised — the URL carries its
   * own signature, so anyone holding it can fetch the object until it expires.
   *
   * `downloadName` sets Content-Disposition on the response. It is sanitised
   * here rather than at the call site so no caller can forget: a filename is
   * user-controlled input that ends up in a response header.
   */
  async signedUrl(
    bucket: Bucket,
    key: string,
    opts: { downloadName?: string | null; inline?: boolean } = {},
  ): Promise<string> {
    const disposition = contentDisposition(
      opts.downloadName ?? null,
      opts.inline ? 'inline' : 'attachment',
    );

    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: disposition,
      }),
      { expiresIn: this.signedUrlTtlSeconds },
    );
  }

  /** Sign a "<bucket>/<key>" ref as stored on a row. Null if the ref is unusable. */
  async signedUrlForRef(
    ref: string | null | undefined,
    opts: { downloadName?: string | null; inline?: boolean } = {},
  ): Promise<string | null> {
    const parsed = parseRef(ref);
    if (!parsed) return null;
    return this.signedUrl(parsed.bucket as Bucket, parsed.key, opts);
  }

  /** Seconds a signed URL remains valid — surfaced so callers can tell clients. */
  get signedUrlTtl(): number {
    return this.signedUrlTtlSeconds;
  }

  /** How long a presigned GET stays valid. Short by design: the URL is a
   *  bearer token for one object, so it must outlive the click and no more. */
  private readonly signedUrlTtlSeconds: number;

  /** Upload a buffer to `bucket` under `key`. Returns its public URL. */
  async upload(
    bucket: Bucket,
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<string> {
    // Keys are generated server-side, so a bad one is a bug rather than an
    // attack — but this is the single choke point every object passes through,
    // which makes it the right place to be sure.
    if (!isSafeKeySegment(key)) {
      throw new Error('Refusing to write an unsafe storage key');
    }
    await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return this.publicUrl(bucket, key);
  }

  /**
   * Best-effort delete. Each ref is a "<bucket>/<key>" string as returned by
   * extractKey(); refs are grouped by bucket and deleted per bucket.
   */
  async remove(refs: (string | null | undefined)[]): Promise<void> {
    const byBucket = new Map<string, string[]>();
    for (const ref of refs) {
      // parseRef, not a hand-rolled split: a malformed or traversing ref must
      // not be able to aim a delete at another bucket.
      const parsed = parseRef(ref);
      if (!parsed) continue;
      (
        byBucket.get(parsed.bucket) ??
        byBucket.set(parsed.bucket, []).get(parsed.bucket)!
      ).push(parsed.key);
    }

    for (const [bucket, keys] of byBucket) {
      try {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })) },
          }),
        );
      } catch (err) {
        this.logger.warn(
          `Failed to delete from ${bucket} [${keys.join(', ')}]: ${String(err)}`,
        );
      }
    }
  }

  /** Public URL for an object: <base>/<bucket>/<key>. */
  publicUrl(bucket: Bucket, key: string): string {
    return `${this.publicBase}/${bucket}/${key}`;
  }

  /**
   * Recover the "<bucket>/<key>" ref from a public URL produced by publicUrl().
   * The returned value is what remove() expects.
   */
  extractKey(url: string | null): string | null {
    if (!url) return null;
    const prefix = `${this.publicBase}/`;
    return url.startsWith(prefix) ? url.slice(prefix.length) : null;
  }
}
