import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { UserBan } from './entities/user-ban.entity';

/**
 * Reads the ban in force from `user_bans`.
 *
 * `users` used to carry banned_at / ban_reason / banned_by alongside this
 * table, and the two were written together to stay in step. They were dropped
 * in DropUserBanColumns: one fact stored twice needs a transaction to stay
 * honest, and a measurement showed the join costs nothing at this scale.
 *
 * "In force" means `lifted_at is null`, and a partial unique index allows at
 * most one such row per user — so these read one ban, not the newest of several.
 */
@Injectable()
export class BanLookupService {
  constructor(
    @InjectRepository(UserBan)
    private readonly bans: Repository<UserBan>,
  ) {}

  /** The ban in force, or null. Use when the reason is needed. */
  activeBan(userId: string): Promise<UserBan | null> {
    return this.bans.findOne({
      where: { user_id: userId, lifted_at: IsNull() },
    });
  }

  /** Whether a ban is in force. Use when only the answer matters. */
  async isBanned(userId: string): Promise<boolean> {
    const count = await this.bans.count({
      where: { user_id: userId, lifted_at: IsNull() },
    });
    return count > 0;
  }

  /**
   * Bans in force across many accounts, keyed by user.
   *
   * For list screens, which would otherwise ask once per row. `bannedBy` is
   * joined because the admin table shows who issued it.
   */
  async activeBansFor(userIds: string[]): Promise<Map<string, UserBan>> {
    if (!userIds.length) return new Map();
    const rows = await this.bans.find({
      where: { user_id: In(userIds), lifted_at: IsNull() },
      relations: { bannedBy: true },
    });
    return new Map(rows.map((b) => [b.user_id, b]));
  }
}
