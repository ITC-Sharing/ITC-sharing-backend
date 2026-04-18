import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { UpdateUserDto } from './dto/update-user.dto';

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

    const { error } = await client
      .from('users')
      .update(updates)
      .eq('id', userId);

    if (error) {
      throw new InternalServerErrorException('Failed to update profile');
    }

    return this.getMe(userId);
  }
}
