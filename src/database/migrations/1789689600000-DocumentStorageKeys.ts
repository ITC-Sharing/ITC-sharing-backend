import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes the storage KEY the canonical identifier for a document's files.
 *
 * Until now a `documents` row recorded only `file_url` — a permanent public URL
 * into MinIO. That URL was both the address and, in practice, the access
 * control: anyone holding it could fetch the object, which quietly bypassed the
 * audience rules the API enforces on every other path.
 *
 * With the bucket private, a URL cannot be permanent any more: access is a
 * short-lived presigned link minted per request, after authorisation. So the
 * row has to store what the object IS ("<bucket>/<key>") rather than where it
 * used to be reachable.
 *
 * `staged_files` already worked this way — it has carried `storage_key` and
 * `preview_key` since it was introduced. This brings `documents` in line.
 *
 * `file_url` and `preview_url` are deliberately kept:
 *   - they are the backfill source, and re-deriving a key later is impossible
 *     once the column is gone;
 *   - avatars, book covers and department logos still serve from public
 *     buckets, and code paths that read a URL keep working;
 *   - dropping a column is the one migration that cannot be rolled back
 *     without data loss.
 * Nothing should AUTHORISE on them. New reads go through the key.
 */
export class DocumentStorageKeys1789689600000 implements MigrationInterface {
  name = 'DocumentStorageKeys1789689600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table documents
        add column if not exists storage_key text,
        add column if not exists preview_key text;
    `);

    /**
     * Backfill from the existing URLs.
     *
     * A stored URL looks like "<base>/<bucket>/<key>". The base is whatever
     * S3_PUBLIC_URL was when the row was written, and it is not recorded
     * anywhere — so rather than guessing it, take everything from the known
     * bucket segment onwards. Every document object lives in the `documents`
     * bucket, which makes "/documents/" a reliable anchor.
     *
     * position() returns 0 when the marker is absent, and the guard below keeps
     * those rows null rather than writing a malformed key.
     */
    await queryRunner.query(`
      update documents
         set storage_key = 'documents/' || substring(file_url from position('/documents/' in file_url) + 11)
       where storage_key is null
         and file_url is not null
         and position('/documents/' in file_url) > 0;
    `);

    await queryRunner.query(`
      update documents
         set preview_key = 'documents/' || substring(preview_url from position('/documents/' in preview_url) + 11)
       where preview_key is null
         and preview_url is not null
         and position('/documents/' in preview_url) > 0;
    `);

    // Downloads look a file up by id and then read its key, so no index is
    // needed for the read path. This one exists for the reverse direction:
    // reconciling storage against the database (finding orphaned objects).
    await queryRunner.query(`
      create index if not exists idx_documents_storage_key
        on documents (storage_key)
        where storage_key is not null;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop index if exists idx_documents_storage_key;`);
    await queryRunner.query(`
      alter table documents
        drop column if exists storage_key,
        drop column if exists preview_key;
    `);
  }
}
