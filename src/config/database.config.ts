import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import * as entities from '../entities';
import { join } from 'path';

// TypeORM connection options built from the environment. The schema is owned by
// the migrations in src/database/migrations, so `synchronize` is always false —
// TypeORM must never alter it on its own.
export function databaseConfig(config: ConfigService): TypeOrmModuleOptions {
  return {
    type: 'postgres',
    url: config.getOrThrow<string>('DATABASE_URL'),
    entities: Object.values(entities),
    // `join(__dirname, ...)` rather than a bare glob: under ts-node __dirname is
    // src/config, in a built image it is dist/config, and each resolves to the
    // migrations that were compiled alongside it.
    migrations: [join(__dirname, '..', 'database', 'migrations', '*.{ts,js}')],
    /**
     * Pending migrations run at boot. On a single-node deployment this is what
     * makes `docker compose up` enough to stand up a brand-new database — there
     * is no separate migrate step to forget, and a restart after a power cut
     * re-checks rather than re-applies.
     *
     * TypeORM takes an advisory lock and records each migration in the
     * `migrations` table, so running it twice is a no-op. Revisit this if the
     * backend is ever scaled past one replica.
     */
    migrationsRun: true,
    synchronize: false,
  };
}
