import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';

/**
 * The first admin account — the one that breaks the bootstrap deadlock.
 *
 * Registration requires a major_id and POST /majors is admin-only, so a fresh
 * database can otherwise never produce its first user. This inserts one
 * directly, with `role = 'admin'` already set.
 *
 * There is deliberately NO default password. If SEED_ADMIN_PASSWORD is unset a
 * random one is generated and printed ONCE — a known default credential on a
 * publicly reachable deployment is how these things get taken over, and this
 * app is meant to sit behind a public URL.
 *
 * Re-running is a no-op: an existing account with the same email is left alone,
 * password included. Delete the row if you need to reissue it.
 */
export async function seedAdmin(dataSource: DataSource): Promise<void> {
  const email = (
    process.env.SEED_ADMIN_EMAIL ?? 'admin@itc.edu.kh'
  ).toLowerCase();
  const firstName = process.env.SEED_ADMIN_FIRST_NAME ?? 'ITC';
  const lastName = process.env.SEED_ADMIN_LAST_NAME ?? 'Admin';
  const majorAcronym = process.env.SEED_ADMIN_MAJOR ?? 'GIC';

  const existing = await dataSource.query<{ id: string; role: string }[]>(
    'select id, role from users where lower(email) = $1',
    [email],
  );

  if (existing.length) {
    const found = existing[0];
    // Promote rather than skip: the usual reason this runs twice is that
    // someone registered the address through the UI and needs it to be admin.
    if (found.role !== 'admin') {
      await dataSource.query(`update users set role = 'admin' where id = $1`, [
        found.id,
      ]);
      console.log(`  admin:   ${email} already existed — promoted to admin`);
    } else {
      console.log(`  admin:   ${email} already present, left untouched`);
    }
    return;
  }

  // Generated passwords are shown once and never stored in plaintext, so make
  // them long enough that being printed to a terminal is the only exposure.
  const generated = !process.env.SEED_ADMIN_PASSWORD;
  const password =
    process.env.SEED_ADMIN_PASSWORD ?? randomBytes(18).toString('base64url');

  // Cost 10 — must match auth.service.ts, or the account cannot log in.
  const passwordHash = await bcrypt.hash(password, 10);

  const [major] = await dataSource.query<{ id: string }[]>(
    'select id from majors where acronym = $1',
    [majorAcronym],
  );

  await dataSource.query(
    `insert into users (first_name, last_name, email, password_hash, role, major_id)
     values ($1, $2, $3, $4, 'admin', $5)`,
    [firstName, lastName, email, passwordHash, major?.id ?? null],
  );

  console.log(`  admin:   created ${email}`);
  if (generated) {
    console.log('');
    console.log('  ┌─────────────────────────────────────────────────────────');
    console.log('  │ Generated admin password — shown once, save it now:');
    console.log(`  │   ${password}`);
    console.log('  │ Change it after first login.');
    console.log('  └─────────────────────────────────────────────────────────');
  }
}
