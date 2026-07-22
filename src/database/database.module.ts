import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { databaseConfig } from '../config/database.config';

// Owns the TypeORM root connection so app.module doesn't carry DB wiring.
// The raw SQL schema/migrations live in backend/db/*.sql and are applied out of
// band (psql / docker), not through TypeORM — see the project notes.
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
