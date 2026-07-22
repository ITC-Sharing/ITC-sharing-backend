import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/**
 * S3-compatible object storage (MinIO in local dev, AWS S3 or any S3 API in prod).
 * Each kind of file lives in its own bucket (see BUCKETS). Objects are addressed
 * as <bucket>/<key> and served by public URL: <S3_PUBLIC_URL>/<bucket>/<key>.
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
  }

  /** Upload a buffer to `bucket` under `key`. Returns its public URL. */
  async upload(
    bucket: Bucket,
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<string> {
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
      if (!ref) continue;
      const slash = ref.indexOf('/');
      if (slash < 1) continue; // no bucket segment — skip
      const bucket = ref.slice(0, slash);
      const key = ref.slice(slash + 1);
      if (!key) continue;
      (byBucket.get(bucket) ?? byBucket.set(bucket, []).get(bucket)!).push(key);
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
