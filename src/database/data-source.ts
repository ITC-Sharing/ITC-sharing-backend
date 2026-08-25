import 'dotenv/config';
import { DataSource } from 'typeorm';
import * as entities from '../entities';

/**
 * DataSource for the TypeORM CLI only — `npm run migration:*`.
 *
 * The running app does NOT use this: it builds its options from ConfigService
 * in config/database.config.ts. Both must describe the same database, so the
 * migration glob and `synchronize: false` are repeated rather than shared —
 * the CLI loads this file standalone, outside the Nest container, so it cannot
 * reach ConfigService.
 *
 * `dotenv/config` is imported for the same reason: without Nest there is no
 * ConfigModule to read backend/.env.
 */
export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: Object.values(entities),
  // Both extensions: ts-node runs the .ts sources, a built image runs dist/.
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  // The schema is owned by the migrations in this folder. TypeORM must never
  // alter it on its own — a stray sync would silently rewrite production.
  synchronize: false,
});
