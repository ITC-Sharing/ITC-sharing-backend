import 'dotenv/config';
import dataSource from '../data-source';
import { seedMajors } from './majors.seeder';
import { seedMajorLogos } from './logos.seeder';
import { seedAdmin } from './admin.seeder';

/**
 * Seed entry point — `npm run seed`.
 *
 * Deliberately NOT wired into application boot, unlike migrations. Migrations
 * are structure and must run everywhere; seed data is a judgement call, and
 * silently creating an admin account every time a container restarts is not a
 * thing a server should do. You run this once, by hand, on a new database.
 *
 * Every seeder is idempotent, so re-running is safe if you are unsure whether
 * it took the first time.
 *
 * Order matters: logos attach to departments and the admin is attached to one
 * too, so majors go first.
 */
async function run(): Promise<void> {
  await dataSource.initialize();
  console.log('Seeding…');

  try {
    await seedMajors(dataSource);
    await seedMajorLogos(dataSource);
    await seedAdmin(dataSource);
  } finally {
    await dataSource.destroy();
  }

  console.log('Done.');
}

run().catch((error: unknown) => {
  console.error('Seeding failed:', error);
  // Non-zero so a failed seed in a deploy script does not look like success.
  process.exit(1);
});
