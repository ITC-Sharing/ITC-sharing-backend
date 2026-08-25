import { readFileSync, readdirSync } from 'fs';
import { extname, join } from 'path';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { BUCKETS, StorageService } from '../../modules/storage/storage.service';

/**
 * Department logos.
 *
 * The files ship in ./assets rather than being referenced by URL, because a
 * URL would be worthless on a new deployment: `majors.image_url` stores an
 * ABSOLUTE url built from S3_PUBLIC_URL, and the objects live in whichever
 * MinIO the app is pointed at. Seeding a row that names a bucket object nobody
 * ever uploaded gives you 13 broken images.
 *
 * So the seeder uploads the bytes, then stores the URL the upload returned —
 * which is correct for whatever host this runs against.
 *
 * Idempotent by "does this department already have a logo?", not by "is the
 * object there?". A logo an admin replaced through the UI is left alone; only
 * departments with no image at all are filled in.
 */

/** Filenames are the lowercased acronym — gic.png is GIC's logo. */
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

export async function seedMajorLogos(dataSource: DataSource): Promise<void> {
  // __dirname resolves to src/… under ts-node and dist/… in a built image;
  // nest-cli.json copies the assets alongside, so both find the files.
  const assetDir = join(__dirname, 'assets');

  let files: string[];
  try {
    files = readdirSync(assetDir);
  } catch {
    console.log('  logos:   no assets directory — skipped');
    return;
  }

  // Constructed directly rather than pulled from the Nest container: the seeder
  // runs as a plain script, and a bare ConfigService already falls back to
  // process.env. Reusing StorageService (not a hand-rolled S3 client) keeps the
  // key layout and the returned URL identical to a real upload.
  const storage = new StorageService(new ConfigService());

  const majors = await dataSource.query<
    { id: string; acronym: string; image_url: string | null }[]
  >('select id, acronym, image_url from majors');

  let uploaded = 0;
  let skipped = 0;

  for (const major of majors) {
    if (major.image_url?.trim()) {
      skipped++;
      continue;
    }

    const slug = major.acronym.toLowerCase();
    const file = files.find((f) => f.slice(0, f.lastIndexOf('.')) === slug);
    if (!file) continue;

    const ext = extname(file).toLowerCase();
    const body = readFileSync(join(assetDir, file));

    const url = await storage.upload(
      BUCKETS.MAJORS,
      `${slug}${ext}`,
      body,
      MIME[ext] ?? 'application/octet-stream',
    );

    await dataSource.query('update majors set image_url = $1 where id = $2', [
      url,
      major.id,
    ]);
    uploaded++;
  }

  const missing = majors.length - uploaded - skipped;
  console.log(
    `  logos:   ${uploaded} uploaded, ${skipped} already had one` +
      (missing ? `, ${missing} with no asset file` : ''),
  );
}
