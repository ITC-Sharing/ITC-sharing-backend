import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../entities/user.entity';
import { BUCKETS, StorageService } from '../storage/storage.service';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly storage: StorageService,
  ) {}

  async getMe(userId: string) {
    const user = await this.users.findOne({
      where: { id: userId },
      relations: { major: true },
    });

    if (!user) throw new NotFoundException('User not found');

    return {
      id: user.id,
      first_name: user.first_name,
      last_name: user.last_name,
      email: user.email,
      major_id: user.major_id,
      year_level: user.year_level,
      avatar_url: user.avatar_url,
      role: user.role,
      created_at: user.created_at,
      majors: user.major
        ? {
            id: user.major.id,
            name: user.major.name,
            acronym: user.major.acronym,
          }
        : null,
    };
  }

  async updateMe(userId: string, dto: UpdateUserDto) {
    // Build the update payload — only include fields that were actually sent
    const updates: Partial<User> = {};
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
      const current = await this.users.findOne({
        where: { id: userId },
        select: { avatar_url: true },
      });
      oldAvatarUrl = current?.avatar_url ?? null;
    }

    try {
      await this.users.update({ id: userId }, updates);
    } catch {
      throw new InternalServerErrorException('Failed to update profile');
    }

    if (oldAvatarUrl && oldAvatarUrl !== dto.avatar_url) {
      await this.deleteAvatarFile(oldAvatarUrl);
    }

    return this.getMe(userId);
  }

  /** Removes an avatar file from storage given its public URL. Best-effort. */
  private async deleteAvatarFile(avatarUrl: string) {
    const key = this.storage.extractKey(avatarUrl);
    if (key) await this.storage.remove([key]);
  }

  async uploadAvatar(userId: string, file: Express.Multer.File) {
    const ext = file.originalname.split('.').pop();
    const key = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    try {
      const url = await this.storage.upload(
        BUCKETS.AVATARS,
        key,
        file.buffer,
        file.mimetype,
      );
      return { url };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      throw new InternalServerErrorException(
        `Avatar upload failed: ${message}`,
      );
    }
  }
}
