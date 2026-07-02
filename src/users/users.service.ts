import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { UpdateUserDto } from './dto/update-user.dto';

const AVATAR_BUCKET = 'avatars';

@Injectable()
export class UsersService {
  constructor(private readonly supabaseService: SupabaseService) {}

  async getMe(userId: string) {
    const client = this.supabaseService.getClient();

    const { data, error } = await client
      .from('users')
      .select(
        `
        id,
        first_name,
        last_name,
        email,
        major_id,
        year_level,
        avatar_url,
        role,
        created_at,
        majors (
          id,
          name,
          acronym
        )
      `,
      )
      .eq('id', userId)
      .single();

    if (error || !data) {
      throw new NotFoundException('User not found');
    }

    return data;
  }

  async updateMe(userId: string, dto: UpdateUserDto) {
    const client = this.supabaseService.getClient();

    // Build the update payload — only include fields that were actually sent
    const updates: Record<string, any> = {};
    if (dto.first_name !== undefined) updates.first_name = dto.first_name;
    if (dto.last_name !== undefined) updates.last_name = dto.last_name;
    if (dto.major_id !== undefined) updates.major_id = dto.major_id;
    if (dto.year_level !== undefined) updates.year_level = dto.year_level;
    if (dto.avatar_url !== undefined) updates.avatar_url = dto.avatar_url;

    if (Object.keys(updates).length === 0) {
      // Nothing to update — just return current profile
      return this.getMe(userId);
    }

    // If the avatar is being changed or removed, remember the old one so we can
    // delete the now-orphaned file from storage after the row is updated.
    let oldAvatarUrl: string | null = null;
    if (dto.avatar_url !== undefined) {
      const { data: current } = await client
        .from('users')
        .select('avatar_url')
        .eq('id', userId)
        .single();
      oldAvatarUrl = current?.avatar_url ?? null;
    }

    const { error } = await client
      .from('users')
      .update(updates)
      .eq('id', userId);

    if (error) {
      throw new InternalServerErrorException('Failed to update profile');
    }

    if (oldAvatarUrl && oldAvatarUrl !== dto.avatar_url) {
      await this.deleteAvatarFile(oldAvatarUrl);
    }

    return this.getMe(userId);
  }

  /** Removes an avatar file from storage given its public URL. Best-effort. */
  private async deleteAvatarFile(avatarUrl: string) {
    const marker = `/storage/v1/object/public/${AVATAR_BUCKET}/`;
    const index = avatarUrl.indexOf(marker);
    if (index === -1) return;
    const path = avatarUrl.slice(index + marker.length);
    await this.supabaseService
      .getClient()
      .storage.from(AVATAR_BUCKET)
      .remove([path]);
  }

  async uploadAvatar(userId: string, file: Express.Multer.File) {
    const client = this.supabaseService.getClient();
    const ext = file.originalname.split('.').pop();
    const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const { error } = await client.storage
      .from(AVATAR_BUCKET)
      .upload(path, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (error) {
      // Surface the real cause (e.g. "Bucket not found") instead of a generic 500.
      throw new InternalServerErrorException(`Avatar upload failed: ${error.message}`);
    }

    const { data } = client.storage.from(AVATAR_BUCKET).getPublicUrl(path);
    return { url: data.publicUrl };
  }
}
