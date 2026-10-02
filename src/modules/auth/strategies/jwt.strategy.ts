import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { UserBan } from '../../users/entities/user-ban.entity';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  /**
   * A valid signature isn't enough: an access token issued before a ban would
   * otherwise keep working until it expired. One lookup per request makes a ban
   * take effect on the next call.
   *
   * Existence and the ban are asked in a single statement, not through
   * BanLookupService like the rest of the codebase. This runs on every
   * authenticated request, and the join is what keeps it to one round trip
   * after the flag on `users` was dropped. The partial index it probes holds
   * only accounts actually banned, so it is nearly empty.
   */
  async validate(payload: { sub: string; email: string }) {
    const row = await this.users
      .createQueryBuilder('u')
      .leftJoin(UserBan, 'b', 'b.user_id = u.id and b.lifted_at is null')
      .select('u.id', 'id')
      .addSelect('b.id is not null', 'banned')
      .where('u.id = :id', { id: payload.sub })
      .getRawOne<{ id: string; banned: boolean }>();

    if (!row) throw new UnauthorizedException('Account no longer exists');
    if (row.banned) throw new UnauthorizedException('Account is banned');

    return { sub: payload.sub, email: payload.email };
  }
}
