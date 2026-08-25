import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../../entities/user.entity';

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
   * otherwise keep working until it expired. One indexed lookup per request
   * makes a ban take effect on the next call.
   */
  async validate(payload: { sub: string; email: string }) {
    const user = await this.users.findOne({
      where: { id: payload.sub },
      select: { id: true, banned_at: true },
    });

    if (!user) throw new UnauthorizedException('Account no longer exists');
    if (user.banned_at) throw new UnauthorizedException('Account is banned');

    return { sub: payload.sub, email: payload.email };
  }
}
