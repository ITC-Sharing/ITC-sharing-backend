import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { TelegramLinkToken } from './entities/telegram-link-token.entity';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';

/**
 * Deliberately depends on nothing but users and its own token table.
 *
 * NotificationsModule imports this one to deliver; if this module reached back
 * for notifications the two would be circular, and the dependency only runs one
 * way in practice — Telegram never creates a notification.
 */
@Module({
  imports: [TypeOrmModule.forFeature([User, TelegramLinkToken]), ConfigModule],
  controllers: [TelegramController],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
