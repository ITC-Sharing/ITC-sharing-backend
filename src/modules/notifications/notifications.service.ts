import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification } from './entities/notification.entity';
import { NotificationsGateway } from './notifications.gateway';
import { TelegramService } from '../telegram/telegram.service';

export interface CreateNotificationPayload {
  user_id: string;
  type: string;
  /** English text, kept as the fallback when a client cannot translate. */
  message: string;
  /** Key into the client's notification locale files. */
  key?: string;
  /** Values the phrase interpolates — titles, names, counts, reasons. */
  params?: Record<string, string | number>;
  ref_id?: string;
  ref_type?: string;
}

/**
 * A notification for whoever reviews a department, rather than for one person.
 *
 * Used when something enters a review queue: the submitter already gets told
 * what happens to it, but nobody was telling the people who have to act.
 */
export interface ReviewerNotificationPayload {
  /**
   * The department the item belongs to. Its moderators are notified alongside
   * every admin; null reaches admins only.
   */
  major_id: string | null;
  type: string;
  message: string;
  key?: string;
  params?: Record<string, string | number>;
  ref_id?: string;
  ref_type?: string;
  /** The submitter. Nobody needs telling about their own submission. */
  except_user_id?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    private readonly gateway: NotificationsGateway,
    private readonly telegram: TelegramService,
  ) {}

  /**
   * Cover image per notification, for the ones that point at a book.
   *
   * A raw query rather than the Book repositories: notifications is imported BY
   * the books module, so reaching back for its entities would close a circular
   * dependency that Nest only untangles with forwardRef.
   *
   * Two paths to the same picture — a notification can name the book directly
   * ('book') or the request it concerns ('book_request').
   */
  private async coversFor(
    rows: { id: string; ref_id: string | null; ref_type: string | null }[],
  ) {
    const ids = rows
      .filter(
        (r) =>
          r.ref_id && (r.ref_type === 'book' || r.ref_type === 'book_request'),
      )
      .map((r) => r.id);
    const covers = new Map<string, string>();
    if (!ids.length) return covers;

    try {
      const found = await this.notifications.manager.query<
        { id: string; cover: string | null }[]
      >(
        `select n.id,
                coalesce(direct.cover_image_url, viaRequest.cover_image_url) as cover
           from notifications n
           left join books direct
             on n.ref_type = 'book' and direct.id = n.ref_id
           left join book_requests r
             on n.ref_type = 'book_request' and r.id = n.ref_id
           left join books viaRequest on viaRequest.id = r.book_id
          where n.id = any($1)`,
        [ids],
      );
      for (const row of found) if (row.cover) covers.set(row.id, row.cover);
    } catch {
      // A missing picture is not worth failing the list over.
    }
    return covers;
  }

  async getForUser(userId: string) {
    let rows: Notification[];
    try {
      rows = await this.notifications.find({
        select: {
          id: true,
          type: true,
          message: true,
          is_read: true,
          ref_id: true,
          ref_type: true,
          i18n_key: true,
          i18n_params: true,
          created_at: true,
        },
        where: { user_id: userId },
        order: { created_at: 'DESC' },
        take: 30,
      });
    } catch {
      throw new InternalServerErrorException('Failed to fetch notifications');
    }

    const covers = await this.coversFor(rows);
    return rows.map((row) => ({
      ...row,
      /** The book's cover, for notifications about one. Null otherwise. */
      image_url: covers.get(row.id) ?? null,
    }));
  }

  async markRead(userId: string, id: string) {
    try {
      await this.notifications.update(
        { id, user_id: userId },
        { is_read: true },
      );
    } catch {
      throw new InternalServerErrorException(
        'Failed to mark notification as read',
      );
    }
    return { message: 'Marked as read' };
  }

  async markAllRead(userId: string) {
    try {
      await this.notifications.update(
        { user_id: userId, is_read: false },
        { is_read: true },
      );
    } catch {
      throw new InternalServerErrorException('Failed to mark all as read');
    }
    return { message: 'All marked as read' };
  }

  async create(payload: CreateNotificationPayload) {
    let saved: Notification;
    try {
      saved = await this.notifications.save(
        this.notifications.create({
          user_id: payload.user_id,
          type: payload.type,
          message: payload.message,
          ref_id: payload.ref_id ?? null,
          ref_type: payload.ref_type ?? null,
          i18n_key: payload.key ?? null,
          i18n_params: payload.params ?? null,
        }),
      );
    } catch {
      throw new InternalServerErrorException('Failed to create notification');
    }

    // The socket payload carries the cover too, so a live notification looks the
    // same as the one the next fetch returns.
    const covers = await this.coversFor([saved]);

    const data = {
      id: saved.id,
      type: saved.type,
      message: saved.message,
      is_read: saved.is_read,
      ref_id: saved.ref_id,
      ref_type: saved.ref_type,
      i18n_key: saved.i18n_key,
      i18n_params: saved.i18n_params,
      created_at: saved.created_at,
      image_url: covers.get(saved.id) ?? null,
    };

    // Push it to the recipient in real time (if they're connected).
    this.gateway.emitToUser(payload.user_id, 'notification', data);

    /**
     * Telegram is a second channel, never a replacement for this one.
     *
     * It runs last, after the row is saved and the socket has fired, and its
     * result is ignored: a user with no Telegram — or a bot that is down, or
     * not configured at all — still has the notification they just earned. Any
     * failure is logged inside the service rather than surfaced here, because
     * the caller is a book or document flow that has already succeeded.
     */
    void this.telegram.notifyUser(payload.user_id, payload.message, saved.id);
  }

  /**
   * Notify everyone who can review this department.
   *
   * Recipients are resolved in one raw query rather than through the admin
   * module: notifications is imported BY admin, so reaching the other way would
   * close a circular dependency that Nest only untangles with forwardRef — the
   * same reason coversFor above is raw SQL.
   *
   * Banned accounts are skipped, and so is the submitter, who is a moderator of
   * their own department often enough for it to matter.
   *
   * Nothing here throws. This runs after an upload or a subject has already
   * been saved; failing to tell a reviewer is not a reason to fail the
   * submission that the student just made.
   */
  async createForReviewers(payload: ReviewerNotificationPayload) {
    let recipients: { id: string }[];
    try {
      recipients = await this.notifications.manager.query<{ id: string }[]>(
        `select u.id
           from users u
          where u.banned_at is null
            and (lower(u.role) = 'admin'
                 or exists (select 1
                              from department_moderators m
                             where m.user_id = u.id
                               and m.major_id = $1))`,
        [payload.major_id],
      );
    } catch (err) {
      this.logger.warn(
        `Could not resolve reviewers to notify: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    for (const recipient of recipients) {
      if (recipient.id === payload.except_user_id) continue;
      try {
        await this.create({
          user_id: recipient.id,
          type: payload.type,
          message: payload.message,
          key: payload.key,
          params: payload.params,
          ref_id: payload.ref_id,
          ref_type: payload.ref_type,
        });
      } catch (err) {
        // One unreachable recipient must not cost the others theirs.
        this.logger.warn(
          `Could not notify reviewer ${recipient.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
