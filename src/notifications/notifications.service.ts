import { Injectable, InternalServerErrorException } from '@nestjs/common';
import * as webpush from 'web-push';
import { SupabaseService } from '../supabase/supabase.service';

export interface CreateNotificationPayload {
  user_id: string;
  type: string;
  message: string;
  ref_id?: string;
  ref_type?: string;
}

import { IsObject, IsString } from 'class-validator';

export class PushSubscriptionDto {
  @IsString()
  endpoint!: string;

  @IsObject()
  keys!: { p256dh: string; auth: string };
}

@Injectable()
export class NotificationsService {
  constructor(private readonly supabaseService: SupabaseService) {
    webpush.setVapidDetails(
      process.env.VAPID_EMAIL!,
      process.env.VAPID_PUBLIC_KEY!,
      process.env.VAPID_PRIVATE_KEY!,
    );
  }

  async getForUser(userId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('notifications')
      .select('id, type, message, is_read, ref_id, ref_type, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(30);

    if (error) throw new InternalServerErrorException('Failed to fetch notifications');
    return data;
  }

  async markRead(userId: string, id: string) {
    const { error } = await this.supabaseService
      .getClient()
      .from('notifications')
      .update({ is_read: true })
      .eq('id', id)
      .eq('user_id', userId);

    if (error) throw new InternalServerErrorException('Failed to mark notification as read');
    return { message: 'Marked as read' };
  }

  async markAllRead(userId: string) {
    const { error } = await this.supabaseService
      .getClient()
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', userId)
      .eq('is_read', false);

    if (error) throw new InternalServerErrorException('Failed to mark all as read');
    return { message: 'All marked as read' };
  }

  async create(payload: CreateNotificationPayload) {
    const { error } = await this.supabaseService
      .getClient()
      .from('notifications')
      .insert({
        user_id: payload.user_id,
        type: payload.type,
        message: payload.message,
        ref_id: payload.ref_id ?? null,
        ref_type: payload.ref_type ?? null,
      });

    if (error) throw new InternalServerErrorException('Failed to create notification');
  }

  // ─── Web push ──────────────────────────────────────────────────────────────

  async savePushSubscription(userId: string, sub: PushSubscriptionDto) {
    const { error } = await this.supabaseService
      .getClient()
      .from('push_subscriptions')
      .upsert(
        {
          user_id: userId,
          endpoint: sub.endpoint,
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth,
        },
        { onConflict: 'user_id,endpoint' },
      );

    if (error) throw new InternalServerErrorException('Failed to save push subscription');
    return { message: 'Subscribed' };
  }

  async sendWebPush(userId: string, title: string, body: string, url?: string) {
    const { data: subs } = await this.supabaseService
      .getClient()
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('user_id', userId);

    if (!subs?.length) return;

    const payload = JSON.stringify({ title, body, url: url ?? '/' });

    await Promise.allSettled(
      subs.map((s) =>
        webpush
          .sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
          )
          .catch(async (err: any) => {
            if (err.statusCode === 410 || err.statusCode === 404) {
              await this.supabaseService
                .getClient()
                .from('push_subscriptions')
                .delete()
                .eq('endpoint', s.endpoint);
            }
          }),
      ),
    );
  }
}
