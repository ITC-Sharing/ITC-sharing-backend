import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { databaseConfig } from '../config/database.config';

// Owns the TypeORM root connection so app.module doesn't carry DB wiring.
// Schema changes are TypeORM migrations in src/database/migrations, applied at
// boot (migrationsRun) — see config/database.config.ts.
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: databaseConfig,
    }),
  ],
})
export class DatabaseModule {}
