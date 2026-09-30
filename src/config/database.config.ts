import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import * as entities from '../database/entities';
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
     * Whether this process migrates the schema at boot.
     *
     * On by default, because that is what makes `docker compose up` enough to
     * stand up a brand-new database with no separate step to forget.
     *
     * It must be OFF once more than one replica runs. TypeORM takes an advisory
     * lock, so concurrent migration is safe rather than corrupting — but the
     * replica that loses the race sits waiting, and a long migration can hold it
     * past its healthcheck window and get it killed mid-deploy. With replicas,
     * the `migrate` service in docker-compose.prod.yml runs once and the
     * backends wait for it to succeed.
     */
    migrationsRun: config.get<string>('MIGRATIONS_RUN') !== 'false',
    synchronize: false,
  };
}
