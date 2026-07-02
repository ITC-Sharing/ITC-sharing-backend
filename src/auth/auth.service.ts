import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';

// Refresh token lifetime — keep in sync with the cookie maxAge in the controller.
export const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const REFRESH_EXPIRES_IN = '7d';

@Injectable()
export class AuthService {
  constructor(
    private supabase: SupabaseService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  private get refreshSecret(): string {
    return this.config.getOrThrow<string>('JWT_REFRESH_SECRET');
  }

  async register(dto: RegisterDto) {
    const client = this.supabase.getClient();

    // Check email not already used
    const { data: existing } = await client
      .from('users')
      .select('id')
      .eq('email', dto.email)
      .single();

    if (existing) {
      throw new BadRequestException(
        'An account with this email already exists',
      );
    }

    // Hash password
    const password_hash = await bcrypt.hash(dto.password, 10);

    // Create user
    const { data: user, error } = await client
      .from('users')
      .insert({
        first_name: dto.first_name,
        last_name: dto.last_name,
        email: dto.email,
        password_hash,
        major_id: dto.major_id,
        year_level: dto.year_level,
      })
      .select(
        'id, first_name, last_name, email, role, major_id, year_level, created_at',
      )
      .single();

    if (error) throw new BadRequestException(error.message);

    const token = this.signToken(user.id, user.email);

    return {
      user: { ...user },
      token,
    };
  }

  async login(dto: LoginDto) {
    const client = this.supabase.getClient();

    // Find user
    const { data: user } = await client
      .from('users')
      .select(
        'id, first_name, last_name, email, password_hash, role, major_id, year_level, avatar_url',
      )
      .eq('email', dto.email)
      .single();

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // Verify password
    const isMatch = await bcrypt.compare(dto.password, user.password_hash);
    if (!isMatch) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const { password_hash: _, ...safeUser } = user;

    const accessToken = this.signToken(user.id, user.email);
    const refreshToken = await this.createRefreshToken(user.id);

    return { user: safeUser, accessToken, refreshToken };
  }

  // ─── Refresh-token lifecycle ─────────────────────────────────────────────

  /** Exchange a valid refresh token for a fresh access token (rotates the refresh token). */
  async refresh(rawToken: string | undefined) {
    if (!rawToken) throw new UnauthorizedException('Missing refresh token');
    const client = this.supabase.getClient();

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
    const { data: row } = await client
      .from('refresh_tokens')
      .select('id')
      .eq('token_hash', this.hashToken(rawToken))
      .single();

    if (!row) throw new UnauthorizedException('Refresh token has been revoked');

    // Rotate: invalidate the used token and issue a new one.
    await client.from('refresh_tokens').delete().eq('id', row.id);

    const { data: user } = await client
      .from('users')
      .select('id, email')
      .eq('id', payload.sub)
      .single();

    if (!user) throw new UnauthorizedException('User no longer exists');

    const accessToken = this.signToken(user.id, user.email);
    const refreshToken = await this.createRefreshToken(user.id);
    return { accessToken, refreshToken };
  }

  /** Revoke a refresh token (logout). Best-effort. */
  async logout(rawToken: string | undefined) {
    if (!rawToken) return;
    await this.supabase
      .getClient()
      .from('refresh_tokens')
      .delete()
      .eq('token_hash', this.hashToken(rawToken));
  }

  /** Create + persist a new refresh token (JWT signed with JWT_REFRESH_SECRET). */
  private async createRefreshToken(userId: string): Promise<string> {
    const raw = this.jwt.sign(
      { sub: userId },
      { secret: this.refreshSecret, expiresIn: REFRESH_EXPIRES_IN },
    );
    const { error } = await this.supabase
      .getClient()
      .from('refresh_tokens')
      .insert({
        user_id: userId,
        token_hash: this.hashToken(raw),
        expires_at: new Date(Date.now() + REFRESH_TTL_MS).toISOString(),
      });

    if (error) {
      throw new InternalServerErrorException(
        `Failed to issue refresh token: ${error.message}`,
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
