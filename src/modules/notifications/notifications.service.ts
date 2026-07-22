import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification } from '../../entities/notification.entity';
import { NotificationsGateway } from './notifications.gateway';

export interface CreateNotificationPayload {
  user_id: string;
  type: string;
  message: string;
  ref_id?: string;
  ref_type?: string;
}

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    private readonly gateway: NotificationsGateway,
  ) {}

  async getForUser(userId: string) {
    try {
      return await this.notifications.find({
        select: {
          id: true,
          type: true,
          message: true,
          is_read: true,
          ref_id: true,
          ref_type: true,
          created_at: true,
        },
        where: { user_id: userId },
        order: { created_at: 'DESC' },
        take: 30,
      });
    } catch {
      throw new InternalServerErrorException('Failed to fetch notifications');
    }
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
        }),
      );
    } catch {
      throw new InternalServerErrorException('Failed to create notification');
    }

    const data = {
      id: saved.id,
      type: saved.type,
      message: saved.message,
      is_read: saved.is_read,
      ref_id: saved.ref_id,
      ref_type: saved.ref_type,
      created_at: saved.created_at,
    };

    // Push it to the recipient in real time (if they're connected).
    this.gateway.emitToUser(payload.user_id, 'notification', data);
  }
}
