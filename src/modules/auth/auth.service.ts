import {
  ForbiddenException,
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import {
  EmailToken,
  type EmailTokenPurpose,
} from './entities/email-token.entity';
import { MailService } from '../mail/mail.service';
import { DevAlertService } from '../../common/alerts/dev-alert.service';
import type { RequestCtx } from '../../common/alerts/request-context';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { OAuth2Client } from 'google-auth-library';
import * as bcrypt from 'bcrypt';
import { createHash, randomInt, randomUUID } from 'crypto';
import ms from 'ms';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
    @InjectRepository(EmailToken)
    private readonly emailTokens: Repository<EmailToken>,
    private jwt: JwtService,
    private config: ConfigService,
    private readonly mail: MailService,
    /**
     * Observability, never a dependency. Every call here returns void and
     * swallows its own failures, so an unreachable Telegram cannot fail a
     * login. The service knows nothing of the Bot API — it reports events.
     */
    private readonly alerts: DevAlertService,
  ) {}

  /** How long each secret is good for, by what it authorises. */
  private static readonly TOKEN_TTL_MS: Record<EmailTokenPurpose, number> = {
    // Three minutes. A six-digit code is small enough to guess at, and the
    // window it is guessable in is part of the defence — the shorter it
    // lives, the fewer guesses fit inside it. Long enough for mail to arrive
    // and be typed; short enough that a code left in an inbox is dead.
    verify: 3 * 60 * 1000,
    // The same three minutes, and for a stronger reason: for as long as it is
    // alive this code is equivalent to the password.
    reset: 3 * 60 * 1000,
  };

  /**
   * How long a freshly issued code lasts, in seconds.
   *
   * Returned with every response that sends one so the countdown on screen is
   * driven by the server's number rather than a constant copied into the
   * client — which is how a changed TTL turns into a timer that lies.
   *
   * Safe to return unconditionally: it is a property of the system, not of any
   * account, so it says nothing about whether the address exists.
   */
  private get codeTtlSeconds(): number {
    return Math.round(AuthService.TOKEN_TTL_MS.verify / 1000);
  }

  /**
   * Wrong guesses allowed against one verification code before it is burned.
   *
   * Five, against a million possibilities, leaves a 1-in-200,000 chance per
   * code issued — and the attacker has to request a new code to keep going,
   * which the `email-send` tier limits to three an hour per address. The cap
   * is doing the work that 32 bytes of entropy used to do.
   */
  private static readonly MAX_CODE_ATTEMPTS = 5;

  /**
   * Separate from the request log on purpose: a replayed refresh token is the
   * one event here worth alerting on, and it should be greppable without
   * wading through every 401 an expired token produces.
   */
  private readonly securityLog = new Logger('AuthSecurity');

  // ─── Registration ─────────────────────────────────────────────────────────
  // One step: register() writes the user and returns the same token pair as
  // login. Nothing is emailed and nothing is staged.

  private get refreshSecret(): string {
    return this.config.getOrThrow<string>('JWT_REFRESH_SECRET');
  }

  /** Refresh-token JWT lifetime, e.g. "7d" (ms format). */
  private get refreshExpiresIn(): string {
    return this.config.getOrThrow<string>('JWT_REFRESH_SECRET_EXPIRATION_IN');
  }

  /**
   * How long after a token is redeemed a second presentation of it is still
   * treated as the same honest client, rather than as a replay.
   *
   * This window exists because the two are genuinely indistinguishable at the
   * moment of arrival. Two tabs restoring a session on the same reload send the
   * same cookie microseconds apart; so does an attacker with a stolen copy. A
   * few seconds separates "the browser did this to itself" from "somebody kept
   * this and came back with it", and the cost of guessing wrong in the strict
   * direction is signing a student out for opening two tabs.
   *
   * Clamped: 0 disables the window entirely (every replay is reuse), and the
   * ceiling keeps a misconfiguration from turning a stolen token into a
   * long-lived one.
   */
  private get reuseGraceMs(): number {
    const seconds = Number(
      this.config.get<string>('REFRESH_REUSE_GRACE_SECONDS'),
    );
    if (!Number.isFinite(seconds) || seconds < 0) return 10_000;
    return Math.min(seconds, 60) * 1000;
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
   * Create the account and sign them in, in one request.
   *
   * There is no email-ownership check any more: the address is whatever the
   * student types. The email stays unique, so a second sign-up with it is
   * rejected rather than silently shadowing the first. The student ID is
   * collected later, by the complete-profile prompt.
   */
  async register(dto: RegisterDto, ctx?: RequestCtx) {
    const email = dto.email.trim().toLowerCase();

    await this.assertEmailFree(email);

    let user: User;
    try {
      user = await this.users.save(
        this.users.create({
          first_name: dto.first_name.trim(),
          last_name: dto.last_name.trim(),
          email,
          // Cost 10 — must match the compare in login().
          password_hash: await bcrypt.hash(dto.password, 10),
        }),
      );
    } catch (err) {
      // The unique index is the real guard: assertEmailFree can lose a race
      // with a concurrent sign-up for the same address.
      const message = err instanceof Error ? err.message : 'Failed to register';
      throw new BadRequestException(message);
    }

    // No tokens. Registering used to sign the caller straight in, which is
    // exactly what made the address unproven: an account was usable the moment
    // someone typed an address they did not own. Now the account exists but
    // cannot be logged into until the link in the inbox is opened.
    await this.issueEmailToken(user, 'verify');

    this.alerts.registered(
      user.email,
      `${user.first_name} ${user.last_name}`,
      ctx,
    );

    return {
      message:
        'Account created. Enter the 6-digit code we emailed you to confirm your address.',
      expires_in: this.codeTtlSeconds,
    };
  }

  private async assertEmailFree(email: string) {
    const existing = await this.users
      .createQueryBuilder('u')
      .where('lower(u.email) = :email', { email })
      .select(['u.id'])
      .getOne();

    if (existing)
      throw new BadRequestException(
        'An account with this email already exists',
      );
  }

  async login(dto: LoginDto, ctx?: RequestCtx) {
    // Find user (password_hash is select:true by default here)
    const user = await this.users.findOne({
      where: { email: dto.email },
    });

    if (!user) {
      // The caller is told only "invalid email or password"; the developer
      // channel is the one place the difference is safe to record, and it is
      // what separates a typo from someone working through a list.
      this.alerts.loginFailed(
        { login: dto.email, reason: 'no such account' },
        ctx,
      );
      throw new UnauthorizedException('Invalid email or password');
    }

    // Created through Google, so there is nothing to compare against. Said
    // explicitly — "invalid password" would send them round in circles.
    if (!user.password_hash) {
      throw new UnauthorizedException(
        'This account signs in with Google — use the Google button',
      );
    }

    // Verify password
    const isMatch = await bcrypt.compare(dto.password, user.password_hash);
    if (!isMatch) {
      this.alerts.loginFailed(
        {
          login: dto.email,
          reason: 'wrong password',
          userId: user.id,
          name: `${user.first_name} ${user.last_name}`,
        },
        ctx,
      );
      throw new UnauthorizedException('Invalid email or password');
    }

    // Checked after the password, like the ban below: answering before it is
    // verified would turn this endpoint into a way to ask "does this address
    // have an account here?" without knowing the password.
    if (!user.email_verified_at) {
      this.alerts.loginFailed(
        {
          login: dto.email,
          reason: 'email not verified',
          userId: user.id,
          name: `${user.first_name} ${user.last_name}`,
        },
        ctx,
      );
      // A code alongside the message, because the client has to tell this
      // apart from the ban below: both are 403, and offering "resend the
      // link" to a banned account would be nonsense. Matching on the prose
      // would work until someone rewords it.
      throw new ForbiddenException({
        message:
          'Confirm your email address before signing in. Check your inbox for the link.',
        code: 'EMAIL_NOT_VERIFIED',
      });
    }

    // Checked after the password so a wrong guess can't reveal that an account
    // exists and is banned.
    if (user.banned_at) {
      this.alerts.loginFailed(
        {
          login: dto.email,
          reason: 'account banned',
          userId: user.id,
          name: `${user.first_name} ${user.last_name}`,
        },
        ctx,
      );
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

    this.alerts.loginSucceeded(
      {
        login: user.email,
        userId: user.id,
        name: `${user.first_name} ${user.last_name}`,
      },
      ctx,
    );

    return { user: safeUser, accessToken, refreshToken };
  }

  /**
   * Step 1 of the redirect flow — where to send the browser.
   *
   * `state` is generated by the caller and echoed back by Google; the callback
   * compares it against a cookie, so a forged callback URL can't sign anyone in.
   */
  buildGoogleAuthUrl(state: string): string {
    return this.googleClient().generateAuthUrl({
      scope: ['openid', 'email', 'profile'],
      state,
      // Always show the chooser: without it a signed-in Google user is bounced
      // straight through, which is confusing on a shared machine.
      prompt: 'select_account',
    });
  }

  /**
   * Step 2 — exchange the one-time code for tokens, then sign in or sign up.
   *
   * The code is swapped server-side using the client secret, so nothing the
   * browser passed through is trusted; the identity comes from the id_token
   * Google returns, whose signature and audience are verified here.
   */
  async completeGoogleLogin(code: string, ctx?: RequestCtx) {
    const client = this.googleClient();

    let idToken: string | undefined;
    try {
      const { tokens } = await client.getToken(code);
      idToken = tokens.id_token ?? undefined;
    } catch {
      this.alerts.loginFailed(
        { login: 'Google OAuth', reason: 'Google rejected the code exchange' },
        ctx,
      );
      throw new UnauthorizedException('Google rejected that sign-in attempt');
    }
    if (!idToken)
      throw new UnauthorizedException('Google returned no identity token');

    let payload: {
      sub: string;
      email?: string;
      email_verified?: boolean;
      given_name?: string;
      family_name?: string;
      name?: string;
    };
    try {
      const ticket = await client.verifyIdToken({
        idToken,
        audience: this.config.getOrThrow<string>('GOOGLE_CLIENT_ID'),
      });
      const parsed = ticket.getPayload();
      if (!parsed) throw new Error('Empty token payload');
      payload = parsed;
    } catch {
      this.alerts.loginFailed(
        { login: 'Google OAuth', reason: 'id_token failed verification' },
        ctx,
      );
      throw new UnauthorizedException('Could not verify that Google account');
    }

    const email = payload.email?.trim().toLowerCase();
    // An unverified address would let anyone claim someone else's account
    // through the email-matching branch below.
    if (!email || !payload.email_verified) {
      this.alerts.loginFailed(
        {
          login: 'Google OAuth',
          reason: 'Google account has no verified email',
        },
        ctx,
      );
      throw new UnauthorizedException(
        'That Google account has no verified email',
      );
    }

    let user = await this.users.findOne({ where: { google_id: payload.sub } });

    if (!user) {
      const byEmail = await this.users
        .createQueryBuilder('u')
        .where('lower(u.email) = :email', { email })
        .getOne();

      if (byEmail) {
        // Link: Google vouches for the address, so this is the same person —
        // and that vouching is exactly what verification asks for, so an
        // account that signed up by password and never opened the link becomes
        // verified by arriving here.
        byEmail.google_id = payload.sub;
        byEmail.email_verified_at ??= new Date();
        user = await this.users.save(byEmail);
      } else {
        const [fallbackFirst, ...fallbackRest] = (payload.name ?? email).split(
          ' ',
        );
        user = await this.users.save(
          this.users.create({
            first_name: payload.given_name || fallbackFirst,
            last_name: payload.family_name || fallbackRest.join(' ') || '-',
            email,
            google_id: payload.sub,
            // Verified on arrival: this branch is only reached after Google's
            // id_token was checked AND email_verified was true on it.
            email_verified_at: new Date(),
            // Name and email are all we take. No password, no student id, no
            // major/year — the complete-profile prompt collects those — and no
            // avatar: profile photos are uploaded here or not set at all.
            password_hash: null,
          }),
        );
      }
    }

    if (user.banned_at) {
      this.alerts.loginFailed(
        {
          login: 'Google OAuth',
          reason: 'account banned',
          userId: user.id,
          name: `${user.first_name} ${user.last_name}`,
        },
        ctx,
      );
      throw new ForbiddenException(
        user.ban_reason
          ? `Your account has been banned: ${user.ban_reason}`
          : 'Your account has been banned',
      );
    }

    const refreshToken = await this.createRefreshToken(user.id);

    // LOGIN names how they came in rather than an address: nothing was typed
    // here, and "Google OAuth" is the fact worth knowing at a glance.
    this.alerts.loginSucceeded(
      {
        login: 'Google OAuth',
        userId: user.id,
        name: `${user.first_name} ${user.last_name}`,
      },
      ctx,
    );

    return { refreshToken };
  }

  /** Configured lazily so a missing secret is a clear error, not a boot crash. */
  private googleClient(): OAuth2Client {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.config.get<string>('GOOGLE_CLIENT_SECRET');
    const redirectUri = this.config.get<string>('GOOGLE_CALLBACK_URL');

    if (!clientId || !clientSecret || !redirectUri)
      throw new InternalServerErrorException(
        'Google sign-in is not configured on this server',
      );

    return new OAuth2Client({ clientId, clientSecret, redirectUri });
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

    // 2. Confirm it's a stored token. A row that is absent was either never
    //    issued here or belongs to a family already revoked — both are final.
    const row = await this.refreshTokens.findOne({
      where: { token_hash: this.hashToken(rawToken) },
      select: {
        id: true,
        user_id: true,
        family_id: true,
        consumed_at: true,
      },
    });

    if (!row) throw new UnauthorizedException('Refresh token has been revoked');

    // 3. Claim it. The conditional update IS the concurrency control: two
    //    requests arriving together both read an unconsumed row, and exactly
    //    one of them can win this write. Reading and then writing would let
    //    both believe they were first.
    const claim = await this.refreshTokens.update(
      { id: row.id, consumed_at: IsNull() },
      { consumed_at: new Date() },
    );

    if (claim.affected !== 1) {
      // Lost the claim: this token had already been redeemed. Whether that is
      // an honest race or a replay is decided by how long ago.
      await this.assertWithinReuseGrace(row.id, row.family_id, row.user_id);
    }

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
    // Same family: the descendant of a rotated token is the same session, and
    // revoking on reuse has to reach all of it.
    const refreshToken = await this.createRefreshToken(user.id, row.family_id);
    return { accessToken, refreshToken };
  }

  /**
   * Decide what an already-consumed token means, and act on it.
   *
   * Returns quietly when the replay is close enough to the original redemption
   * to be the same client racing itself. Otherwise it is reuse: the whole
   * family goes, including whatever the thief (or the victim) is holding, and
   * both sides have to sign in again.
   *
   * Revoking the family rather than the single row is the point. The attacker
   * who replayed an old token may already have rotated it into a current one;
   * deleting only what was presented would leave them with the live session and
   * sign out the person they stole it from.
   */
  private async assertWithinReuseGrace(
    id: string,
    familyId: string,
    userId: string,
  ): Promise<void> {
    // Re-read: the row we hold was fetched before the claim, so its
    // consumed_at is stale by exactly the interval being measured.
    const current = await this.refreshTokens.findOne({
      where: { id },
      select: { consumed_at: true },
    });

    const consumedAt = current?.consumed_at;
    const age = consumedAt ? Date.now() - consumedAt.getTime() : Infinity;

    // Strictly less than, so a window of 0 really is no window: `<=` would
    // admit the simultaneous replay it is meant to catch.
    if (age < this.reuseGraceMs) {
      // Two tabs restoring the same session on one reload. Both get a token;
      // both are the same person. Logged at debug because it is ordinary.
      this.securityLog.debug(
        `refresh race user=${userId} family=${familyId} age=${age}ms — within grace`,
      );
      return;
    }

    const deleted = await this.refreshTokens.delete({ family_id: familyId });

    this.alerts.refreshReuse(userId, familyId, deleted.affected ?? 0);

    this.securityLog.error(
      `refresh token REUSE user=${userId} family=${familyId} ` +
        `age=${Number.isFinite(age) ? `${age}ms` : 'unknown'} ` +
        `revoked=${deleted.affected ?? 0} — every session in this family is now dead`,
    );

    // The same message a revoked token gets. Telling a caller that the token
    // was specifically *reused* confirms they are holding a real credential.
    throw new UnauthorizedException('Refresh token has been revoked');
  }

  /**
   * Revoke a session (logout). Best-effort.
   *
   * Takes the whole family, not the row presented. Signing out means the
   * session is over, and its ancestors are consumed rows that only exist to
   * catch a replay — there is nothing left to detect once the session they
   * belong to is deliberately dead.
   */
  async logout(rawToken: string | undefined) {
    if (!rawToken) return;
    const row = await this.refreshTokens.findOne({
      where: { token_hash: this.hashToken(rawToken) },
      select: { family_id: true },
    });
    if (!row) return;
    await this.refreshTokens.delete({ family_id: row.family_id });
  }

  // ─── Email verification and password reset ───────────────────────────────

  /**
   * Prove an address with the six-digit code that was mailed to it.
   *
   * Addressed by email rather than by the code alone, and that is forced by how
   * the code is stored: bcrypt has a per-row salt, so there is nothing to look
   * a code up BY. The email names the row; the code is then compared against
   * it. That is also why a code from one account cannot be typed into another.
   *
   * ── Why the answers are so uniform ───────────────────────────────────────
   * No account, already verified, no code outstanding, expired, wrong: all one
   * message. Distinguishing them would turn this into an oracle for which
   * addresses are registered and which are mid-signup, and the person actually
   * holding a code is not helped by the distinction — the way out of every one
   * of those states is the same, ask for a new code.
   */
  async verifyEmailCode(email: string, code: string) {
    const user = await this.redeemCode(email, code, 'verify', (candidate) =>
      // Already-verified addresses are refused here rather than waved through,
      // and refused in the same words as everything else — otherwise this
      // endpoint answers "has this address finished signing up?".
      Boolean(candidate.email_verified_at),
    );

    const verifiedAt = new Date();
    await this.users.update(
      { id: user.id, email_verified_at: IsNull() },
      { email_verified_at: verifiedAt },
    );

    /**
     * Signed in, rather than sent back to the login screen.
     *
     * Someone who has just typed their password and then proved they can read
     * the inbox has done strictly more than an ordinary login asks for, so
     * making them type the password a second time is friction with nothing
     * behind it.
     *
     * The reset flow still refuses to do this. There the password is being
     * set by someone who could not produce the old one, so the session is
     * withheld until they can type the new one — a cheap extra step that
     * means an abandoned reset does not leave a logged-in tab behind.
     */
    user.email_verified_at = verifiedAt;
    const { password_hash, major, ...safeUser } = user;
    const accessToken = this.signToken(user.id, user.email);
    const refreshToken = await this.createRefreshToken(user.id);

    return {
      message: 'Email confirmed.',
      user: safeUser,
      accessToken,
      refreshToken,
    };
  }

  /**
   * Send the verification link again.
   *
   * Answers identically whether or not the address has an account, and whether
   * or not it was already verified. Anything else turns this into a way to test
   * addresses against the user table — the same leak the login errors are
   * careful to avoid.
   */
  async resendVerification(email: string) {
    const user = await this.findByEmail(email);

    if (user && !user.email_verified_at && !user.banned_at) {
      await this.issueEmailToken(user, 'verify');
    }

    return {
      message:
        'If that address needs confirming, a new code is on its way to it.',
      expires_in: this.codeTtlSeconds,
    };
  }

  /**
   * Start a password reset.
   *
   * Same silence, same reason. Note the second condition: an account created
   * through Google has no password of ours to reset, so it gets nothing — and
   * the caller cannot tell that apart from an address that was never
   * registered.
   */
  async forgotPassword(email: string, ctx?: RequestCtx) {
    const user = await this.findByEmail(email);

    if (user?.password_hash && user.email_verified_at && !user.banned_at) {
      await this.issueEmailToken(user, 'reset');
    } else {
      /**
       * Nothing was sent. Recorded here and nowhere else: the HTTP response
       * below is identical either way, and must stay that way — the endpoint
       * deliberately refuses to say whether an address is registered. The
       * developer channel is not the caller, so it may know.
       */
      this.alerts.loginFailed(
        {
          login: email,
          reason: user
            ? 'reset requested for a Google-only or unverified account'
            : 'reset requested for an unknown address',
        },
        ctx,
      );
    }

    return {
      message:
        'If that address has an account, a reset code is on its way to it.',
      expires_in: this.codeTtlSeconds,
    };
  }

  /**
   * Finish a password reset.
   *
   * Every existing session dies with the old password. Someone resetting has
   * either forgotten it or suspects somebody else knows it, and in the second
   * case leaving the intruder's refresh token alive would make the reset worse
   * than useless — the victim would believe they had locked the door.
   */
  /**
   * Is this reset code right?
   *
   * Answers without spending it, so the UI can take the password only after
   * the code is known to be good. The code is still spent by resetPassword
   * itself — this is a look, not a claim.
   */
  async checkResetCode(email: string, code: string) {
    await this.redeemCode(email, code, 'reset', undefined, false);
    return { message: 'Code accepted.' };
  }

  async resetPassword(
    email: string,
    code: string,
    password: string,
    ctx?: RequestCtx,
  ) {
    const user = await this.redeemCode(email, code, 'reset');

    await this.users.update(
      { id: user.id },
      {
        // Cost 10 — must match register() and the compare in login().
        password_hash: await bcrypt.hash(password, 10),
        // A reset only ever follows a mail that arrived, so it proves
        // ownership exactly as the verification code does.
        email_verified_at: new Date(),
      },
    );

    const revoked = await this.refreshTokens.delete({ user_id: user.id });

    this.securityLog.warn(
      `password reset completed user=${user.id} — all sessions revoked`,
    );
    this.alerts.passwordReset(user.email, revoked.affected ?? 0, ctx);

    return { message: 'Password changed. Sign in with your new password.' };
  }

  /**
   * Check an emailed code and hand back whose it is.
   *
   * Shared by both flows deliberately. They ask the same question — does this
   * person have the inbox — and the answer is protected by the same three
   * things: bcrypt, a ten-minute window, and a cap on guesses. Two copies of
   * that would be two places for the cap to be forgotten, and the one without
   * it would be the one that mattered.
   *
   * ── Why every failure says the same thing ────────────────────────────────
   * No account, wrong code, no code outstanding, already used: one message.
   * Distinguishing them turns this into an oracle for which addresses are
   * registered, and the person actually holding a code is not helped — the way
   * out of every one of those states is to ask for a new code.
   *
   * Expiry and the attempt cap are the two exceptions, because they are the
   * only states where the reader would otherwise retype a code that can never
   * work, and neither reveals whether the account exists: both are reachable
   * only by someone who already had a live code.
   */
  private async redeemCode(
    email: string,
    code: string,
    purpose: EmailTokenPurpose,
    reject?: (user: User) => boolean,
    /**
     * When false the code is checked but NOT spent, so the caller can confirm
     * it before asking for anything else. Used by the reset flow, which shows
     * the new-password fields only once the code is known to be right —
     * otherwise someone types a password twice and only then learns the code
     * was wrong.
     *
     * A wrong guess still costs an attempt. Checking without counting would be
     * an unlimited oracle against a six-digit secret, which is the one thing
     * the cap exists to prevent.
     */
    consume = true,
  ): Promise<User> {
    const generic = new BadRequestException(
      'That code is not valid. Check it, or ask for a new one.',
    );

    const user = await this.findByEmail(email);
    if (!user || user.banned_at || reject?.(user)) throw generic;

    const row = await this.emailTokens.findOne({
      where: { user_id: user.id, purpose, consumed_at: IsNull() },
    });
    if (!row) throw generic;

    if (row.expires_at.getTime() <= Date.now()) {
      await this.emailTokens.update(
        { id: row.id },
        { consumed_at: new Date() },
      );
      throw new BadRequestException(
        'That code has expired. Ask for a new one.',
      );
    }

    // Checked BEFORE the compare, so a burned code cannot go on being guessed
    // at while the counter sits at its ceiling.
    if (row.attempts >= AuthService.MAX_CODE_ATTEMPTS) {
      await this.emailTokens.update(
        { id: row.id },
        { consumed_at: new Date() },
      );
      this.securityLog.warn(
        `${purpose} code burned user=${user.id} — attempt cap reached`,
      );
      this.alerts.codeBurned(purpose, user.email);
      throw new BadRequestException(
        'Too many incorrect codes. Ask for a new one.',
      );
    }

    if (!(await bcrypt.compare(code, row.token_hash))) {
      // Counted in the database, not in memory: the cap has to survive a
      // restart and hold across replicas, or it is not a cap.
      await this.emailTokens.increment({ id: row.id }, 'attempts', 1);
      throw generic;
    }

    if (!consume) return user;

    // Right code. The conditional update decides the race — two tabs
    // submitting the same code must not both proceed.
    const claim = await this.emailTokens.update(
      { id: row.id, consumed_at: IsNull() },
      { consumed_at: new Date() },
    );
    if (claim.affected !== 1) throw generic;

    return user;
  }

  /**
   * Mint a one-time token, store its hash, mail the link.
   *
   * Live tokens of the same purpose are consumed first. Without that, asking
   * for three reset mails leaves three working links in three inboxes, and the
   * oldest outlives the reason it was sent.
   *
   * The send is awaited and its failure swallowed: a failed mail must not roll
   * back an account that was created, and must not change the response in a way
   * that reveals whether an address exists. MailService has already logged it.
   */
  private async issueEmailToken(
    user: User,
    purpose: EmailTokenPurpose,
  ): Promise<void> {
    await this.emailTokens.update(
      { user_id: user.id, purpose, consumed_at: IsNull() },
      { consumed_at: new Date() },
    );

    // Six digits, for both jobs. Each is typed by a person with the form
    // already open in front of them, so neither needs to survive a round trip
    // through a browser address bar.
    //
    // A short secret is only safe because of what surrounds it: bcrypt so a
    // database leak does not hand over live codes, ten minutes so the window
    // is narrow, and MAX_CODE_ATTEMPTS so it cannot be searched. Remove any
    // one of those three and six digits becomes indefensible.
    //
    // randomInt, not Math.random: this is a credential, and a predictable
    // generator would make the attempt cap pointless.
    const raw = String(randomInt(0, 1_000_000)).padStart(6, '0');

    await this.emailTokens.save(
      this.emailTokens.create({
        user_id: user.id,
        purpose,
        // bcrypt, never SHA-256: six digits is a million-row table an attacker
        // builds in seconds, so a fast hash would expose every live code.
        token_hash: await bcrypt.hash(raw, 10),
        expires_at: new Date(Date.now() + AuthService.TOKEN_TTL_MS[purpose]),
        consumed_at: null,
        attempts: 0,
      }),
    );

    try {
      if (purpose === 'verify') {
        await this.mail.sendRegistrationOtp(user.email, raw);
      } else {
        await this.mail.sendPasswordReset(user.email, raw);
      }
    } catch {
      // Already logged where it happened.
    }

    // The code itself only travels outside production, and only when
    // TELEGRAM_ALERTS_INCLUDE_CODES is on — see DevAlertService.
    this.alerts.codeIssued(
      purpose,
      user.email,
      this.alerts.mayIncludeCodes ? raw : undefined,
    );
  }

  /** Case-insensitive: addresses are stored lower-cased but typed however. */
  private findByEmail(email: string): Promise<User | null> {
    return this.users
      .createQueryBuilder('u')
      .where('lower(u.email) = :email', { email: email.trim().toLowerCase() })
      .getOne();
  }

  /**
   * Create + persist a new refresh token (JWT signed with JWT_REFRESH_SECRET).
   *
   * `familyId` is passed when rotating, so the child stays in the lineage its
   * parent belongs to. Omitting it starts a new family, which is what a fresh
   * sign-in is — login, register and the Google callback all want a lineage
   * that no earlier token can revoke.
   */
  private async createRefreshToken(
    userId: string,
    familyId?: string,
  ): Promise<string> {
    // `jti` is what makes the token unique. Without it the payload is just
    // { sub, iat, exp } — and iat has one-second resolution, so two tokens
    // issued for the same user in the same second are byte-identical and
    // collide on the token_hash unique index. Signing up (which now issues a
    // refresh token) and logging straight in is exactly that case.
    const raw = this.jwt.sign(
      { sub: userId, jti: randomUUID() },
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
          family_id: familyId ?? randomUUID(),
          consumed_at: null,
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
