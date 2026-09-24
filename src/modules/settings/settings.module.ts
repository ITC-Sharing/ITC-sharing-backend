import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppSetting } from './entities/app-setting.entity';
import { PromotionSettingsService } from './promotion-settings.service';

/**
 * Admin-editable operational values. Deliberately tiny and dependency-free, so
 * both the users module (which reads the schedule) and the admin module (which
 * writes it) can import it without either depending on the other.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AppSetting])],
  providers: [PromotionSettingsService],
  exports: [PromotionSettingsService],
})
export class SettingsModule {}
