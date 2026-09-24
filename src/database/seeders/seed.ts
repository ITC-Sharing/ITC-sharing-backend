import 'dotenv/config';
import dataSource from '../data-source';
import { seedMajors } from './majors.seeder';
import { seedMajorLogos } from './logos.seeder';

/**
 * Seed entry point — `npm run seed`.
 *
 * Deliberately NOT wired into application boot, unlike migrations. Migrations
 * are structure and must run everywhere; seed data is a judgement call. You run
 * this once, by hand, on a new database.
 *
 * Every seeder is idempotent, so re-running is safe if you are unsure whether
 * it took the first time.
 *
 * Order matters: logos attach to departments, so majors go first.
 *
 * NOTE: this no longer creates an admin account. A fresh database has no admin
 * and no way to make one through the API — every route that grants the role is
 * itself behind AdminGuard. Promote a registered account directly:
 *
 *   update users set role = 'admin' where email = 'you@itc.edu.kh';
 */
async function run(): Promise<void> {
  await dataSource.initialize();
  console.log('Seeding…');

  try {
    await seedMajors(dataSource);
    await seedMajorLogos(dataSource);
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
