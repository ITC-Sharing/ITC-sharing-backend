import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import configuration from './config/configuration';
import { validateEnv } from './config/validation';
import { DatabaseModule } from './database/database.module';
import { StorageModule } from './modules/storage/storage.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { MajorsModule } from './modules/majors/majors.module';
import { SubjectsModule } from './modules/subjects/subjects.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { AdminModule } from './modules/admin/admin.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { BooksModule } from './modules/books/books.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    DatabaseModule,
    StorageModule,
    AuthModule,
    UsersModule,
    MajorsModule,
    SubjectsModule,
    DocumentsModule,
    AdminModule,
    NotificationsModule,
    BooksModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Registered as providers rather than app.useGlobal*() so Nest injects into
    // them (TransformInterceptor needs Reflector for @ResponseMessage).
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    // Together these log every request exactly once: the interceptor covers
    // successes, the filter covers failures (including guard rejections, which
    // never reach an interceptor).
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
