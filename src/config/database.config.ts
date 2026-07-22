import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import * as entities from '../entities';

// TypeORM connection options built from the environment. The schema is owned by
// db/init.sql, so `synchronize` is always false — TypeORM must never alter it.
export function databaseConfig(config: ConfigService): TypeOrmModuleOptions {
  return {
    type: 'postgres',
    url: config.getOrThrow<string>('DATABASE_URL'),
    entities: Object.values(entities),
    synchronize: false,
  };
}
