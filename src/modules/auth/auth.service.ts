import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../entities/user.entity';
import { RefreshToken } from '../../entities/refresh-token.entity';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import ms from 'ms';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  private get refreshSecret(): string {
    return this.config.getOrThrow<string>('JWT_REFRESH_SECRET');
  }

  /** Refresh-token JWT lifetime, e.g. "7d" (ms format). */
  private get refreshExpiresIn(): string {
    return this.config.getOrThrow<string>('JWT_REFRESH_SECRET_EXPIRATION_IN');
  }

  /**
   * Refresh-token lifetime in milliseconds, derived from
   * JWT_REFRESH_SECRET_EXPIRATION_IN so the JWT expiry, the cookie maxAge, and
   * the DB expires_at all stay in sync from one source of truth.
   */
  get refreshTtlMs(): number {
    return ms(this.refreshExpiresIn as ms.StringValue);
  }

  async register(dto: RegisterDto) {
    // Check email not already used
    const existing = await this.users.findOne({
      where: { email: dto.email },
      select: { id: true },
    });

    if (existing) {
      throw new BadRequestException(
        'An account with this email already exists',
      );
    }

    // Hash password
    const password_hash = await bcrypt.hash(dto.password, 10);

    // Create user
    let user: User;
    try {
      user = await this.users.save(
        this.users.create({
          first_name: dto.first_name,
          last_name: dto.last_name,
          email: dto.email,
          password_hash,
          major_id: dto.major_id,
          year_level: dto.year_level,
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to register';
      throw new BadRequestException(message);
    }

    const token = this.signToken(user.id, user.email);

    return {
      user: {
        id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        role: user.role,
        major_id: user.major_id,
        year_level: user.year_level,
        created_at: user.created_at,
      },
      token,
    };
  }

  async login(dto: LoginDto) {
    // Find user (password_hash is select:true by default here)
    const user = await this.users.findOne({
      where: { email: dto.email },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // Verify password
    const isMatch = await bcrypt.compare(dto.password, user.password_hash);
    if (!isMatch) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // Strip the password hash and the loaded major relation from the response;
    // ...safeUser keeps everything else. (ignoreRestSiblings lets these go
    // unused without a lint error.)
    const { password_hash, major, ...safeUser } = user;

    const accessToken = this.signToken(user.id, user.email);
    const refreshToken = await this.createRefreshToken(user.id);

    return { user: safeUser, accessToken, refreshToken };
  }

  // ─── Refresh-token lifecycle ─────────────────────────────────────────────

  /** Exchange a valid refresh token for a fresh access token (rotates the refresh token). */
  async refresh(rawToken: string | undefined) {
    if (!rawToken) throw new UnauthorizedException('Missing refresh token');

    // 1. Verify the JWT signature + expiry against the refresh secret.
    let payload: { sub: string };
    try {
      payload = await this.jwt.verifyAsync<{ sub: string }>(rawToken, {
        secret: this.refreshSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // 2. Confirm it's the current stored token (handles rotation + revocation).
    const row = await this.refreshTokens.findOne({
      where: { token_hash: this.hashToken(rawToken) },
      select: { id: true },
    });

    if (!row) throw new UnauthorizedException('Refresh token has been revoked');

    // Rotate: invalidate the used token and issue a new one.
    await this.refreshTokens.delete({ id: row.id });

    const user = await this.users.findOne({
      where: { id: payload.sub },
      select: { id: true, email: true },
    });

    if (!user) throw new UnauthorizedException('User no longer exists');

    const accessToken = this.signToken(user.id, user.email);
    const refreshToken = await this.createRefreshToken(user.id);
    return { accessToken, refreshToken };
  }

  /** Revoke a refresh token (logout). Best-effort. */
  async logout(rawToken: string | undefined) {
    if (!rawToken) return;
    await this.refreshTokens.delete({ token_hash: this.hashToken(rawToken) });
  }

  /** Create + persist a new refresh token (JWT signed with JWT_REFRESH_SECRET). */
  private async createRefreshToken(userId: string): Promise<string> {
    const raw = this.jwt.sign(
      { sub: userId },
      {
        secret: this.refreshSecret,
        expiresIn: this.refreshExpiresIn as ms.StringValue,
      },
    );
    try {
      await this.refreshTokens.save(
        this.refreshTokens.create({
          user_id: userId,
          token_hash: this.hashToken(raw),
          expires_at: new Date(Date.now() + this.refreshTtlMs),
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      throw new InternalServerErrorException(
        `Failed to issue refresh token: ${message}`,
      );
    }
    return raw;
  }

  // Store only a hash of the refresh token, never the raw value.
  private hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  private signToken(userId: string, email: string): string {
    return this.jwt.sign({ sub: userId, email });
  }
}
