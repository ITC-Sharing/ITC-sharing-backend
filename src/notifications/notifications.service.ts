import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
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
    private readonly supabaseService: SupabaseService,
    private readonly gateway: NotificationsGateway,
  ) {}

  async getForUser(userId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('notifications')
      .select('id, type, message, is_read, ref_id, ref_type, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(30);

    if (error)
      throw new InternalServerErrorException('Failed to fetch notifications');
    return data;
  }

  async markRead(userId: string, id: string) {
    const { error } = await this.supabaseService
      .getClient()
      .from('notifications')
      .update({ is_read: true })
      .eq('id', id)
      .eq('user_id', userId);

    if (error)
      throw new InternalServerErrorException(
        'Failed to mark notification as read',
      );
    return { message: 'Marked as read' };
  }

  async markAllRead(userId: string) {
    const { error } = await this.supabaseService
      .getClient()
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', userId)
      .eq('is_read', false);

    if (error)
      throw new InternalServerErrorException('Failed to mark all as read');
    return { message: 'All marked as read' };
  }

  async create(payload: CreateNotificationPayload) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('notifications')
      .insert({
        user_id: payload.user_id,
        type: payload.type,
        message: payload.message,
        ref_id: payload.ref_id ?? null,
        ref_type: payload.ref_type ?? null,
      })
      .select('id, type, message, is_read, ref_id, ref_type, created_at')
      .single();

    if (error)
      throw new InternalServerErrorException('Failed to create notification');

    // Push it to the recipient in real time (if they're connected).
    this.gateway.emitToUser(payload.user_id, 'notification', data);
  }
}
