import {
  ForbiddenException,
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
import { PendingRegistration } from '../../entities/pending-registration.entity';
import { MailService } from '../mail/mail.service';
import {
  RegisterDto,
  ResendOtpDto,
  SetPasswordDto,
  VerifyOtpDto,
  deriveEmail,
} from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import * as bcrypt from 'bcrypt';
import { createHash, randomInt } from 'crypto';
import ms from 'ms';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
    @InjectRepository(PendingRegistration)
    private readonly pending: Repository<PendingRegistration>,
    private jwt: JwtService,
    private config: ConfigService,
    private readonly mail: MailService,
  ) {}

  // ─── Registration (three steps) ───────────────────────────────────────────
  // 1. register()          details in, code out
  // 2. verifyOtp()         code proves the address
  // 3. completeRegistration()  password set, account created
  //
  // Nothing is written to `users` before step 3, so an abandoned attempt leaves
  // an expiring pending row rather than an account that can never log in.

  /** How long a code is good for. Long enough to find the email, short enough
   *  that a stolen one is useless by the time anyone acts on it. */
  private static readonly OTP_TTL_MS = 10 * 60 * 1000;

  /** Guessing budget before the code is burned. 6 digits is only 10^6 wide. */
  private static readonly OTP_MAX_ATTEMPTS = 5;

  /** Minimum gap between sends, so this cannot be used to spam an inbox. */
  private static readonly RESEND_COOLDOWN_MS = 60 * 1000;

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

  /**
   * Step 1 — take the details, issue a code.
   *
   * The email is DERIVED from the student ID, never accepted from the client:
   * the code proving address ownership is worthless if the registrant picks
   * where it goes.
   */
  async register(dto: RegisterDto) {
    const studentId = dto.student_id.trim().toLowerCase();
    const email = deriveEmail(studentId);

    await this.assertNotAlreadyRegistered(studentId, email);

    const code = this.generateOtp();
    const now = new Date();

    // Upsert: starting over replaces the in-flight attempt (unique on email)
    // rather than erroring, which is what a student re-submitting expects.
    await this.pending.upsert(
      {
        student_id: studentId,
        email,
        first_name: dto.first_name.trim(),
        last_name: dto.last_name.trim(),
        major_id: dto.major_id,
        year_level: dto.year_level,
        otp_hash: await bcrypt.hash(code, 10),
        otp_expires_at: new Date(now.getTime() + AuthService.OTP_TTL_MS),
        attempts: 0,
        verified_at: null,
        last_sent_at: now,
      },
      ['email'],
    );

    await this.mail.sendRegistrationOtp(email, code);

    return {
      email,
      expires_in_seconds: AuthService.OTP_TTL_MS / 1000,
      // Tells the UI to show "check the server log" instead of "check your
      // inbox" when nothing can actually be delivered.
      delivered: this.mail.isConfigured,
    };
  }

  /** Step 2 — check the code. Does not create the account. */
  async verifyOtp(dto: VerifyOtpDto) {
    const row = await this.loadPending(dto.student_id);
    await this.assertCodeValid(row, dto.code);

    await this.pending.update({ id: row.id }, { verified_at: new Date() });
    return { verified: true };
  }

  /**
   * Step 3 — set the password, which finally creates the account.
   *
   * The code is checked AGAIN here, not just the verified_at flag: otherwise
   * knowing a student ID that happens to be mid-registration would be enough to
   * claim the account by racing to this endpoint.
   */
  async completeRegistration(dto: SetPasswordDto) {
    const row = await this.loadPending(dto.student_id);

    if (!row.verified_at)
      throw new BadRequestException('Verify your email code first');

    await this.assertCodeValid(row, dto.code);
    // Re-checked after the slow bcrypt above: the address may have been claimed
    // while this request was in flight.
    await this.assertNotAlreadyRegistered(row.student_id, row.email);

    let user: User;
    try {
      user = await this.users.save(
        this.users.create({
          first_name: row.first_name,
          last_name: row.last_name,
          email: row.email,
          student_id: row.student_id,
          password_hash: await bcrypt.hash(dto.password, 10),
          major_id: row.major_id,
          year_level: row.year_level,
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to register';
      throw new BadRequestException(message);
    }

    await this.pending.delete({ id: row.id });

    const token = this.signToken(user.id, user.email);

    return {
      user: {
        id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        student_id: user.student_id,
        role: user.role,
        major_id: user.major_id,
        year_level: user.year_level,
        created_at: user.created_at,
      },
      token,
    };
  }

  /** Issue a fresh code, resetting the guessing budget with it. */
  async resendOtp(dto: ResendOtpDto) {
    const row = await this.loadPending(dto.student_id);

    const waited = Date.now() - new Date(row.last_sent_at).getTime();
    if (waited < AuthService.RESEND_COOLDOWN_MS) {
      const seconds = Math.ceil(
        (AuthService.RESEND_COOLDOWN_MS - waited) / 1000,
      );
      throw new BadRequestException(
        `Please wait ${seconds}s before requesting another code`,
      );
    }

    const code = this.generateOtp();
    const now = new Date();
    await this.pending.update(
      { id: row.id },
      {
        otp_hash: await bcrypt.hash(code, 10),
        otp_expires_at: new Date(now.getTime() + AuthService.OTP_TTL_MS),
        attempts: 0,
        last_sent_at: now,
      },
    );

    await this.mail.sendRegistrationOtp(row.email, code);
    return {
      email: row.email,
      expires_in_seconds: AuthService.OTP_TTL_MS / 1000,
      delivered: this.mail.isConfigured,
    };
  }

  // ─── Registration helpers ─────────────────────────────────────────────────

  /** Cryptographically random, not Math.random — this is a credential. */
  private generateOtp(): string {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  private async assertNotAlreadyRegistered(studentId: string, email: string) {
    const existing = await this.users
      .createQueryBuilder('u')
      .where('lower(u.email) = :email', { email })
      .orWhere('lower(u.student_id) = :studentId', { studentId })
      .select(['u.id'])
      .getOne();

    if (existing)
      throw new BadRequestException(
        'An account for this student ID already exists',
      );
  }

  private async loadPending(studentId: string): Promise<PendingRegistration> {
    const row = await this.pending.findOne({
      where: { student_id: studentId.trim().toLowerCase() },
    });
    if (!row)
      throw new BadRequestException(
        'No registration in progress for this student ID — start again',
      );
    return row;
  }

  /**
   * Constant-ish checks in a fixed order: expiry, then budget, then the code
   * itself. A wrong guess costs an attempt; an expired or exhausted row is
   * deleted so the flow restarts cleanly instead of lingering.
   */
  private async assertCodeValid(row: PendingRegistration, code: string) {
    if (new Date(row.otp_expires_at).getTime() < Date.now()) {
      await this.pending.delete({ id: row.id });
      throw new BadRequestException('That code has expired — start again');
    }

    if (row.attempts >= AuthService.OTP_MAX_ATTEMPTS) {
      await this.pending.delete({ id: row.id });
      throw new BadRequestException('Too many incorrect codes — start again');
    }

    if (!(await bcrypt.compare(code, row.otp_hash))) {
      await this.pending.increment({ id: row.id }, 'attempts', 1);
      const left = AuthService.OTP_MAX_ATTEMPTS - (row.attempts + 1);
      throw new BadRequestException(
        left > 0
          ? `Incorrect code — ${left} attempt${left === 1 ? '' : 's'} left`
          : 'Incorrect code — start again',
      );
    }
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

    // Checked after the password so a wrong guess can't reveal that an account
    // exists and is banned.
    if (user.banned_at) {
      throw new ForbiddenException(
        user.ban_reason
          ? `Your account has been banned: ${user.ban_reason}`
          : 'Your account has been banned',
      );
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
      select: { id: true, email: true, banned_at: true },
    });

    if (!user) throw new UnauthorizedException('User no longer exists');
    // Banning revokes stored refresh tokens, but check anyway: this is the one
    // place a long-lived session could otherwise renew itself.
    if (user.banned_at)
      throw new ForbiddenException('Your account has been banned');

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
