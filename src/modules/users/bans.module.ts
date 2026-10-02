import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserBan } from './entities/user-ban.entity';
import { BanLookupService } from './ban-lookup.service';

/**
 * Answers "is this account banned?" for everything that needs to ask.
 *
 * Its own module rather than part of UsersModule: auth, admin and notifications
 * all ask, and routing that through UsersModule would make AuthModule depend on
 * it in one direction while it already depends on auth in the other. This
 * depends on nothing but the repository, so it cannot close a cycle.
 */
@Module({
  imports: [TypeOrmModule.forFeature([UserBan])],
  providers: [BanLookupService],
  exports: [BanLookupService],
})
export class BansModule {}
