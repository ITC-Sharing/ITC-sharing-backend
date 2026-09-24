import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppSetting } from './entities/app-setting.entity';

/** The one key this service owns. */
const KEY = 'promotion_rollover_at';

export interface PromotionSchedule {
  /** The configured instant, or null when no extra rollover is scheduled. */
  rollover_at: Date | null;
  /** Whether that instant is in the past — i.e. the rollover is now in effect. */
  has_passed: boolean;
  updated_at: Date | null;
  updated_by: string | null;
}

/**
 * When students move up a year. The only thing that promotes them.
 *
 * Lives in the database rather than an environment variable so an admin can
 * change it from the dashboard: rolling a whole institute forward is an
 * operational decision, not a deployment.
 *
 * Reads are cached for a few seconds because getMe — the app's first call on
 * every page load — needs this, and the value changes perhaps twice a year.
 */
@Injectable()
export class PromotionSettingsService {
  private readonly logger = new Logger(PromotionSettingsService.name);

  /** Long enough to spare the database, short enough that a change feels live. */
  private static readonly CACHE_MS = 10_000;
  private cached: { at: Date | null; until: number } | null = null;

  constructor(
    @InjectRepository(AppSetting)
    private readonly settings: Repository<AppSetting>,
  ) {}

  /** The configured instant, or null. Never throws — promotion is not worth a 500. */
  async rolloverAt(): Promise<Date | null> {
    if (this.cached && Date.now() < this.cached.until) return this.cached.at;

    let at: Date | null = null;
    try {
      const row = await this.settings.findOne({ where: { key: KEY } });
      if (row?.value) {
        const parsed = new Date(row.value);
        at = Number.isNaN(parsed.getTime()) ? null : parsed;
      }
    } catch (err) {
      this.logger.warn(
        `Could not read the promotion schedule: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Fall through with null: no scheduled rollover is the safe answer. A
      // database blip must not advance anybody by accident.
    }

    this.cached = { at, until: Date.now() + PromotionSettingsService.CACHE_MS };
    return at;
  }

  async get(): Promise<PromotionSchedule> {
    const row = await this.settings.findOne({ where: { key: KEY } });
    const at = row?.value ? new Date(row.value) : null;
    const valid = at && !Number.isNaN(at.getTime()) ? at : null;
    return {
      rollover_at: valid,
      has_passed: !!valid && valid <= new Date(),
      updated_at: row?.updated_at ?? null,
      updated_by: row?.updated_by ?? null,
    };
  }

  /**
   * Schedule a rollover, or clear it by passing null.
   *
   * Setting a NEW instant schedules a new event: every student whose stamp is
   * older than it advances once when it passes, including students who were
   * advanced by a previous one. That is the whole point of storing an instant
   * rather than a year.
   */
  async set(value: string | null, adminId: string): Promise<PromotionSchedule> {
    let iso: string | null = null;
    if (value !== null) {
      const at = new Date(value);
      if (Number.isNaN(at.getTime())) {
        throw new BadRequestException(
          'Enter a valid date and time for the promotion.',
        );
      }
      iso = at.toISOString();
    }

    await this.settings.save({
      key: KEY,
      value: iso,
      updated_by: adminId,
      updated_at: new Date(),
    });
    this.cached = null; // the next read must see it

    this.logger.log(
      iso
        ? `Promotion rollover scheduled for ${iso} by ${adminId}`
        : `Promotion rollover cleared by ${adminId}`,
    );
    return this.get();
  }
}
