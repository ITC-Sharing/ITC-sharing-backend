import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BooksService } from './books.service';

/**
 * Releases books whose reservation ran out.
 *
 * A separate class from BooksService so the schedule lives next to nothing
 * else: the service holds the rule, this decides when it runs. Backend-driven
 * on purpose — a frontend timer only fires while someone has the page open, and
 * the book nobody is looking at is exactly the one that gets stuck.
 */
@Injectable()
export class BooksScheduler {
  private readonly logger = new Logger(BooksScheduler.name);

  constructor(private readonly books: BooksService) {}

  /**
   * Hourly. The window is measured in days, so the precise minute is
   * irrelevant, and an hourly sweep keeps each run small.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async releaseExpiredReservations() {
    try {
      const { expired } = await this.books.expireStaleReservations();
      if (expired > 0)
        this.logger.log(`Released ${expired} expired book reservation(s)`);
    } catch (err) {
      // Never let a sweep failure take the process down; the next run retries.
      this.logger.error('Failed to release expired reservations', err);
    }
  }
}
