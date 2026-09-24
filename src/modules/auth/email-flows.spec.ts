import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { EmailToken } from './entities/email-token.entity';
import { MailService } from '../mail/mail.service';
import { User } from '../users/entities/user.entity';

/**
 * Email verification and password reset.
 *
 * Driven through fake repositories rather than mocks: what matters here is
 * state over time — which token is live, what a second click does, what is left
 * of a session after a reset — none of which a "was it called" assertion says
 * anything about.
 */

const SECRET = 'secret-for-email-flow-specs';

interface Sent {
  to: string;
  /** The six-digit code, for either purpose. */
  body: string;
  kind: 'verify' | 'reset';
}

class FakeUsers {
  rows: User[] = [];
  private seq = 0;

  create(partial: Partial<User>): User {
    return { id: `user-${++this.seq}`, ...partial } as User;
  }
  save(row: User): Promise<User> {
    if (!this.rows.includes(row)) this.rows.push(row);
    return Promise.resolve(row);
  }
  findOne(options: { where: Partial<User> }): Promise<User | null> {
    const where = options.where;
    const hit = this.rows.find((r) =>
      Object.entries(where).every(
        ([k, v]) => (r as unknown as Record<string, unknown>)[k] === v,
      ),
    );
    return Promise.resolve(hit ?? null);
  }
  update(
    criteria: Record<string, unknown>,
    patch: Partial<User>,
  ): Promise<{ affected: number }> {
    // Only the predicates this service actually uses: an id, optionally paired
    // with `email_verified_at: IsNull()`.
    const target = this.rows.find((r) => {
      if (r.id !== criteria.id) return false;
      if ('email_verified_at' in criteria)
        return (
          r.email_verified_at === null || r.email_verified_at === undefined
        );
      return true;
    });
    if (!target) return Promise.resolve({ affected: 0 });
    Object.assign(target, patch);
    return Promise.resolve({ affected: 1 });
  }
  createQueryBuilder() {
    let email = '';
    const qb = {
      where: (_sql: string, params: { email: string }) => {
        email = params.email;
        return qb;
      },
      select: () => qb,
      getOne: () =>
        Promise.resolve(
          this.rows.find((r) => r.email.toLowerCase() === email) ?? null,
        ),
    };
    return qb;
  }
}

class FakeEmailTokens {
  rows: EmailToken[] = [];
  private seq = 0;

  create(partial: Partial<EmailToken>): EmailToken {
    return { id: `tok-${++this.seq}`, ...partial } as EmailToken;
  }
  save(row: EmailToken): Promise<EmailToken> {
    this.rows.push(row);
    return Promise.resolve(row);
  }
  /**
   * Honours every predicate the service actually passes, `user_id` and
   * `consumed_at` included.
   *
   * An earlier version matched only on token_hash/purpose/id, which meant it
   * cheerfully returned another account's row — and the test asserting that a
   * code cannot verify a different account passed for entirely the wrong
   * reason. A fake that is looser than the thing it stands in for does not
   * test the thing, it tests the fake.
   */
  findOne(options: {
    where: {
      token_hash?: string;
      purpose?: string;
      id?: string;
      user_id?: string;
      consumed_at?: unknown;
    };
  }): Promise<EmailToken | null> {
    const { token_hash, purpose, id, user_id } = options.where;
    // The only way the service uses this key is `consumed_at: IsNull()`.
    const mustBeLive = 'consumed_at' in options.where;
    const hit = this.rows.find(
      (r) =>
        (token_hash === undefined || r.token_hash === token_hash) &&
        (purpose === undefined || r.purpose === purpose) &&
        (id === undefined || r.id === id) &&
        (user_id === undefined || r.user_id === user_id) &&
        (!mustBeLive || !r.consumed_at),
    );
    return Promise.resolve(hit ? { ...hit } : null);
  }
  update(
    criteria: Record<string, unknown>,
    patch: Partial<EmailToken>,
  ): Promise<{ affected: number }> {
    // `consumed_at` in the criteria always means IsNull() here.
    const wantsLive = 'consumed_at' in criteria;
    const matches = this.rows.filter((r) => {
      if (criteria.id !== undefined && r.id !== criteria.id) return false;
      if (criteria.user_id !== undefined && r.user_id !== criteria.user_id)
        return false;
      if (criteria.purpose !== undefined && r.purpose !== criteria.purpose)
        return false;
      if (wantsLive && r.consumed_at) return false;
      return true;
    });
    matches.forEach((r) => Object.assign(r, patch));
    return Promise.resolve({ affected: matches.length });
  }

  increment(
    criteria: { id: string },
    field: 'attempts',
    by: number,
  ): Promise<{ affected: number }> {
    const target = this.rows.find((r) => r.id === criteria.id);
    if (!target) return Promise.resolve({ affected: 0 });
    target[field] = (target[field] ?? 0) + by;
    return Promise.resolve({ affected: 1 });
  }

  get live(): EmailToken[] {
    return this.rows.filter((r) => !r.consumed_at);
  }
}

describe('email verification and password reset', () => {
  let users: FakeUsers;
  let emailTokens: FakeEmailTokens;
  let refreshTokens: {
    rows: { user_id: string }[];
    create: (p: { user_id: string }) => { user_id: string };
    save: (r: { user_id: string }) => Promise<{ user_id: string }>;
    delete: jest.Mock;
  };
  let service: AuthService;
  let sent: Sent[];

  /** Both flows now mail a six-digit code; the mailer is handed it directly. */
  const codeFrom = (s: Sent) => s.body;

  beforeEach(() => {
    users = new FakeUsers();
    emailTokens = new FakeEmailTokens();
    sent = [];

    refreshTokens = {
      rows: [],
      // login() mints one; the reset path deletes them. Both halves are needed
      // for "a reset signs every device out" to mean anything.
      create: (partial: { user_id: string }) => partial,
      save: (row: { user_id: string }) => {
        refreshTokens.rows.push(row);
        return Promise.resolve(row);
      },
      delete: jest.fn((criteria: { user_id?: string }) => {
        const before = refreshTokens.rows.length;
        refreshTokens.rows = refreshTokens.rows.filter(
          (r) => r.user_id !== criteria.user_id,
        );
        return Promise.resolve({
          affected: before - refreshTokens.rows.length,
        });
      }),
    };

    const mail = {
      sendRegistrationOtp: (to: string, code: string) => {
        sent.push({ to, body: code, kind: 'verify' });
        return Promise.resolve();
      },
      sendPasswordReset: (to: string, code: string) => {
        sent.push({ to, body: code, kind: 'reset' });
        return Promise.resolve();
      },
    } as unknown as MailService;

    const config = {
      get: (key: string) =>
        key === 'CORS_ORIGIN' ? 'http://localhost:5173' : undefined,
      // Per key, not one value for all: the expiry keys are timespans, and
      // handing jsonwebtoken a secret where it wants "7d" fails at sign time.
      getOrThrow: (key: string) =>
        key.endsWith('_EXPIRATION_IN') ? '7d' : SECRET,
    } as unknown as ConfigService;

    service = new AuthService(
      users as unknown as never,
      refreshTokens as unknown as never,
      emailTokens as unknown as never,
      new JwtService({ secret: SECRET }),
      config,
      mail,
      {
        // Observability only — asserted separately in dev-alert.service.spec.
        loginSucceeded: () => undefined,
        loginFailed: () => undefined,
        registered: () => undefined,
        codeIssued: () => undefined,
        codeBurned: () => undefined,
        passwordReset: () => undefined,
        refreshReuse: () => undefined,
        serverError: () => undefined,
        mayIncludeCodes: false,
      } as never,
    );
  });

  async function register(email = 'dara@itc.edu.kh', password = 'pass-word-1') {
    return service.register({
      first_name: 'Sok',
      last_name: 'Dara',
      email,
      password,
    } as never);
  }

  describe('registration', () => {
    it('creates an unverified account and mails a code, without signing anyone in', async () => {
      const result = await register();

      // The absence of a token IS the fix: registering used to hand back a
      // session for an address nobody had shown they owned.
      expect(result).not.toHaveProperty('accessToken');
      expect(result.message).toMatch(/6-digit code/i);

      expect(users.rows[0].email_verified_at).toBeFalsy();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ to: 'dara@itc.edu.kh', kind: 'verify' });
      expect(sent[0].body).toMatch(/^\d{6}$/);
    });

    it('refuses login until the address is confirmed, and says which problem it is', async () => {
      await register();

      await expect(
        service.login({
          email: 'dara@itc.edu.kh',
          password: 'pass-word-1',
        } as never),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // The code exists so the client can tell this apart from a ban, which is
      // also a 403 but must not be offered a "resend the link" button.
      await service
        .login({ email: 'dara@itc.edu.kh', password: 'pass-word-1' } as never)
        .catch((e: ForbiddenException) => {
          expect(e.getResponse()).toMatchObject({
            code: 'EMAIL_NOT_VERIFIED',
          });
        });
    });

    it('lets the account in once the code is entered', async () => {
      await register();
      await service.verifyEmailCode('dara@itc.edu.kh', codeFrom(sent[0]));

      expect(users.rows[0].email_verified_at).toBeInstanceOf(Date);
      const session = await service.login({
        email: 'dara@itc.edu.kh',
        password: 'pass-word-1',
      } as never);
      expect(session.accessToken).toBeTruthy();
    });

    it('signs the account in as it confirms, rather than sending it to a login form', async () => {
      await register();
      const result = await service.verifyEmailCode(
        'dara@itc.edu.kh',
        codeFrom(sent[0]),
      );

      // Typing the password and then proving the inbox is strictly more than
      // a login asks for, so asking for the password again buys nothing.
      expect(result.accessToken).toBeTruthy();
      expect(result.refreshToken).toBeTruthy();
      expect(result.user).toMatchObject({ email: 'dara@itc.edu.kh' });
      // Never the hash, here or anywhere else.
      expect(result.user).not.toHaveProperty('password_hash');
    });

    it('still refuses to sign anyone in from a password reset', async () => {
      await register();
      await service.verifyEmailCode('dara@itc.edu.kh', codeFrom(sent[0]));
      await service.forgotPassword('dara@itc.edu.kh');

      // The difference is who is holding the secret. A reset link reaches
      // people who have forgotten their password, so a session there would be
      // granted to whoever opened the mail and nobody else.
      const result = await service.resetPassword(
        'dara@itc.edu.kh',
        codeFrom(sent[1]),
        'brand-new-pass',
      );
      expect(result).not.toHaveProperty('accessToken');
    });
  });

  describe('the secret itself', () => {
    it('works once — a spent code is not accepted again', async () => {
      await register();
      const code = codeFrom(sent[0]);
      await service.verifyEmailCode('dara@itc.edu.kh', code);

      await expect(
        service.verifyEmailCode('dara@itc.edu.kh', code),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('is refused once it has expired, and the row is spent', async () => {
      await register();
      emailTokens.rows[0].expires_at = new Date(Date.now() - 1000);

      await expect(
        service.verifyEmailCode('dara@itc.edu.kh', codeFrom(sent[0])),
      ).rejects.toThrow(/expired/i);
      // Burned rather than left lying around for the clock to be argued with.
      expect(emailTokens.live).toHaveLength(0);
    });

    it('cannot be redeemed at the wrong door', async () => {
      await register();
      // A verification code presented to the reset endpoint. Both live in one
      // table, so the purpose has to be part of the lookup rather than a note.
      // Looked up by (user, purpose), so a verify code simply is not there
      // when the reset door goes looking — one table, two keyholes.
      await expect(
        service.resetPassword(
          'dara@itc.edu.kh',
          codeFrom(sent[0]),
          'new-password-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('stores the code under bcrypt, not a fast hash', async () => {
      await register();
      const code = codeFrom(sent[0]);

      // SHA-256 of six digits is a million-row table an attacker builds in
      // seconds, so a leak would expose every live code. bcrypt is the point.
      expect(emailTokens.rows[0].token_hash).not.toBe(code);
      expect(emailTokens.rows[0].token_hash).toMatch(/^\$2[aby]\$/);
    });

    it('stores the reset code under bcrypt as well', async () => {
      await register();
      await service.verifyEmailCode('dara@itc.edu.kh', codeFrom(sent[0]));
      await service.forgotPassword('dara@itc.edu.kh');

      // Both purposes are six digits now, so both need the slow hash. A
      // SHA-256 here would be the more dangerous of the two to leak.
      expect(codeFrom(sent[1])).toMatch(/^\d{6}$/);
      expect(emailTokens.rows[1].token_hash).toMatch(/^\$2[aby]\$/);
    });

    it('supersedes the previous one, so an old inbox cannot be used later', async () => {
      await register();
      await service.verifyEmailCode('dara@itc.edu.kh', codeFrom(sent[0]));
      await service.forgotPassword('dara@itc.edu.kh');
      const first = codeFrom(sent[1]);

      await service.forgotPassword('dara@itc.edu.kh');
      const second = codeFrom(sent[2]);

      expect(first).not.toBe(second);
      expect(emailTokens.live).toHaveLength(1);
      // The older code is consumed the moment the newer one is issued, so it
      // no longer matches the live row — refused in the same words as any
      // other wrong code, which is all an attacker should learn.
      await expect(
        service.resetPassword('dara@itc.edu.kh', first, 'new-password-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      const ok = await service.resetPassword(
        'dara@itc.edu.kh',
        second,
        'new-password-1',
      );
      expect(ok.message).toContain('Password changed');
    });
  });

  /**
   * The whole reason a six-digit code is safe. Without a cap, a million
   * possibilities is minutes of scripted guessing — the secret is small, so
   * the limit on guesses is the defence rather than the secret itself.
   */
  describe('guessing the code', () => {
    /** A wrong code that is still six digits, so it reaches the compare. */
    function wrong(right: string): string {
      return right === '000000' ? '111111' : '000000';
    }

    it('counts wrong guesses in the database, not in memory', async () => {
      await register();
      const bad = wrong(codeFrom(sent[0]));

      await expect(
        service.verifyEmailCode('dara@itc.edu.kh', bad),
      ).rejects.toBeInstanceOf(BadRequestException);

      // In the row, so the cap survives a restart and holds across replicas.
      expect(emailTokens.rows[0].attempts).toBe(1);
    });

    it('burns the code after five wrong guesses', async () => {
      await register();
      const right = codeFrom(sent[0]);
      const bad = wrong(right);

      for (let i = 0; i < 5; i++) {
        await expect(
          service.verifyEmailCode('dara@itc.edu.kh', bad),
        ).rejects.toBeInstanceOf(BadRequestException);
      }

      // Even the RIGHT code is refused now: the attacker cannot outlast the
      // cap by eventually landing on it, and the honest user asks for a new
      // one — which is cheap for them and rationed for an attacker.
      await expect(
        service.verifyEmailCode('dara@itc.edu.kh', right),
      ).rejects.toThrow(/too many/i);
      expect(emailTokens.live).toHaveLength(0);
      expect(users.rows[0].email_verified_at).toBeFalsy();
    });

    it('does not let a code verify a different account', async () => {
      await register('dara@itc.edu.kh');
      await register('nita@itc.edu.kh');
      const daraCode = codeFrom(sent[0]);

      // bcrypt salts per row, so the code is compared only against the row the
      // email names — there is no global code space to fish in.
      await expect(
        service.verifyEmailCode('nita@itc.edu.kh', daraCode),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(users.rows[1].email_verified_at).toBeFalsy();
    });

    it('says the same thing for a wrong code and an address with no account', async () => {
      await register();
      const bad = wrong(codeFrom(sent[0]));

      const wrongCode = await service
        .verifyEmailCode('dara@itc.edu.kh', bad)
        .catch((e: BadRequestException) => e.message);
      const noAccount = await service
        .verifyEmailCode('nobody@itc.edu.kh', '123456')
        .catch((e: BadRequestException) => e.message);

      // Otherwise this endpoint answers "is this address registered?" for
      // anyone willing to send one wrong code.
      expect(wrongCode).toBe(noAccount);
    });

    it('says the same thing for an address that is already verified', async () => {
      await register();
      await service.verifyEmailCode('dara@itc.edu.kh', codeFrom(sent[0]));

      const after = await service
        .verifyEmailCode('dara@itc.edu.kh', '123456')
        .catch((e: BadRequestException) => e.message);
      const noAccount = await service
        .verifyEmailCode('nobody@itc.edu.kh', '123456')
        .catch((e: BadRequestException) => e.message);

      expect(after).toBe(noAccount);
    });
  });

  describe('forgot password', () => {
    /** The one sentence that must come back no matter what is true. */
    const SAME =
      'If that address has an account, a reset code is on its way to it.';

    it('says the same thing for an address with no account', async () => {
      const result = await service.forgotPassword('nobody@itc.edu.kh');
      expect(result.message).toBe(SAME);
      expect(sent).toHaveLength(0);
    });

    it('says the same thing for a Google account with no password of ours', async () => {
      await users.save(
        users.create({
          email: 'google@itc.edu.kh',
          password_hash: null,
          email_verified_at: new Date(),
          banned_at: null,
        }),
      );

      const result = await service.forgotPassword('google@itc.edu.kh');
      expect(result.message).toBe(SAME);
      // Nothing to reset, so nothing sent — and the caller cannot tell.
      expect(sent).toHaveLength(0);
    });

    it('says the same thing for a real account, and sends', async () => {
      await register();
      await service.verifyEmailCode('dara@itc.edu.kh', codeFrom(sent[0]));

      const result = await service.forgotPassword('DARA@itc.edu.kh');
      expect(result.message).toBe(SAME);
      expect(sent[1]).toMatchObject({ kind: 'reset' });
    });
  });

  describe('reset password', () => {
    async function readyToReset() {
      await register();
      await service.verifyEmailCode('dara@itc.edu.kh', codeFrom(sent[0]));
      refreshTokens.rows.push({ user_id: users.rows[0].id });
      refreshTokens.rows.push({ user_id: users.rows[0].id });
      await service.forgotPassword('dara@itc.edu.kh');
      return codeFrom(sent[1]);
    }

    it('changes the password', async () => {
      const token = await readyToReset();
      await service.resetPassword('dara@itc.edu.kh', token, 'brand-new-pass');

      const stored = users.rows[0].password_hash!;
      expect(await bcrypt.compare('brand-new-pass', stored)).toBe(true);
      expect(await bcrypt.compare('pass-word-1', stored)).toBe(false);
    });

    it('signs every other device out', async () => {
      const token = await readyToReset();
      // Three: the session confirming the address created, plus the two
      // stand-ins for other devices.
      expect(refreshTokens.rows).toHaveLength(3);

      await service.resetPassword('dara@itc.edu.kh', token, 'brand-new-pass');

      // Someone resetting may be locking an intruder out. Leaving the
      // intruder's refresh token alive would make the reset worse than
      // useless — the victim would believe the door was shut.
      expect(refreshTokens.rows).toHaveLength(0);
    });

    it('cannot be replayed', async () => {
      const token = await readyToReset();
      await service.resetPassword('dara@itc.edu.kh', token, 'brand-new-pass');

      await expect(
        service.resetPassword('dara@itc.edu.kh', token, 'another-password'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('confirms the address, since the mail demonstrably arrived', async () => {
      await register();
      // Never opened the verification link, but proved the inbox by resetting.
      users.rows[0].email_verified_at = new Date();
      await service.forgotPassword('dara@itc.edu.kh');
      users.rows[0].email_verified_at = null;

      await service.resetPassword(
        'dara@itc.edu.kh',
        codeFrom(sent[1]),
        'brand-new-pass',
      );
      expect(users.rows[0].email_verified_at).toBeInstanceOf(Date);
    });
  });

  /**
   * The reset code is the more dangerous of the two — it changes a password
   * rather than confirming an address — so the controls that make six digits
   * defensible are asserted separately here rather than assumed from the
   * verification tests.
   */
  describe('guessing the reset code', () => {
    async function readyToGuess() {
      await register();
      await service.verifyEmailCode('dara@itc.edu.kh', codeFrom(sent[0]));
      await service.forgotPassword('dara@itc.edu.kh');
      return codeFrom(sent[1]);
    }

    it('burns the reset code after five wrong guesses', async () => {
      const right = await readyToGuess();
      const bad = right === '000000' ? '111111' : '000000';

      for (let i = 0; i < 5; i++) {
        await expect(
          service.resetPassword('dara@itc.edu.kh', bad, 'new-password-1'),
        ).rejects.toBeInstanceOf(BadRequestException);
      }

      // The right code no longer works either — an attacker cannot outlast
      // the cap by eventually landing on it.
      await expect(
        service.resetPassword('dara@itc.edu.kh', right, 'new-password-1'),
      ).rejects.toThrow(/too many/i);

      // And crucially, the password is untouched.
      expect(
        await bcrypt.compare('pass-word-1', users.rows[0].password_hash!),
      ).toBe(true);
    });

    it('refuses an expired reset code', async () => {
      const code = await readyToGuess();
      emailTokens.rows[1].expires_at = new Date(Date.now() - 1000);

      await expect(
        service.resetPassword('dara@itc.edu.kh', code, 'new-password-1'),
      ).rejects.toThrow(/expired/i);
    });

    it("will not let one account's code reset another", async () => {
      const daraCode = await readyToGuess();
      await register('nita@itc.edu.kh');

      await expect(
        service.resetPassword('nita@itc.edu.kh', daraCode, 'new-password-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('answers a wrong code and an unknown address identically', async () => {
      const right = await readyToGuess();
      const bad = right === '000000' ? '111111' : '000000';

      const wrongCode = await service
        .resetPassword('dara@itc.edu.kh', bad, 'new-password-1')
        .catch((e: BadRequestException) => e.message);
      const noAccount = await service
        .resetPassword('nobody@itc.edu.kh', '123456', 'new-password-1')
        .catch((e: BadRequestException) => e.message);

      expect(wrongCode).toBe(noAccount);
    });
  });

  describe('the code window', () => {
    it('tells the client how long the code lasts, so the countdown is not a guess', async () => {
      const result = await register();
      expect(result.expires_in).toBe(180);
    });

    it('says the same for a resend and for a reset, and for any address', async () => {
      await register();
      const resend = await service.resendVerification('dara@itc.edu.kh');
      const reset = await service.forgotPassword('dara@itc.edu.kh');
      // Unconditional on purpose: a window that appeared only for real
      // accounts would answer the question the messages refuse to.
      const unknown = await service.forgotPassword('nobody@itc.edu.kh');

      expect(resend.expires_in).toBe(180);
      expect(reset.expires_in).toBe(180);
      expect(unknown.expires_in).toBe(180);
    });

    it('actually expires the code after that window', async () => {
      await register();
      const row = emailTokens.rows[0];
      const lifetime = row.expires_at.getTime() - row.created_at?.getTime();

      // created_at is set by the database in production, so fall back to the
      // stored expiry being roughly three minutes out from now.
      const fromNow = row.expires_at.getTime() - Date.now();
      expect(Number.isFinite(lifetime) ? lifetime : fromNow).toBeGreaterThan(
        170_000,
      );
      expect(
        Number.isFinite(lifetime) ? lifetime : fromNow,
      ).toBeLessThanOrEqual(180_000);
    });
  });

  describe('checking a reset code before spending it', () => {
    async function ready() {
      await register();
      await service.verifyEmailCode('dara@itc.edu.kh', codeFrom(sent[0]));
      await service.forgotPassword('dara@itc.edu.kh');
      return codeFrom(sent[1]);
    }

    it('accepts the right code without consuming it', async () => {
      const code = await ready();

      const checked = await service.checkResetCode('dara@itc.edu.kh', code);
      expect(typeof checked.message).toBe('string');

      // Still live: the check is a look, not a claim, so the password step
      // that follows can still spend it.
      expect(emailTokens.live).toHaveLength(1);
      const reset = await service.resetPassword(
        'dara@itc.edu.kh',
        code,
        'brand-new-pass',
      );
      expect(typeof reset.message).toBe('string');
    });

    it('can be checked repeatedly — knowing the code is the secret', async () => {
      const code = await ready();
      await service.checkResetCode('dara@itc.edu.kh', code);
      await service.checkResetCode('dara@itc.edu.kh', code);
      await expect(
        service.checkResetCode('dara@itc.edu.kh', code),
      ).resolves.toBeTruthy();
      expect(emailTokens.rows[1].attempts).toBe(0);
    });

    it('counts a wrong guess, so it is not a free oracle', async () => {
      const right = await ready();
      const bad = right === '000000' ? '111111' : '000000';

      await expect(
        service.checkResetCode('dara@itc.edu.kh', bad),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(emailTokens.rows[1].attempts).toBe(1);
    });

    it('is bound by the same five-attempt cap', async () => {
      const right = await ready();
      const bad = right === '000000' ? '111111' : '000000';

      for (let i = 0; i < 5; i++) {
        await expect(
          service.checkResetCode('dara@itc.edu.kh', bad),
        ).rejects.toBeInstanceOf(BadRequestException);
      }

      // Burned by checking alone — the cap cannot be sidestepped by guessing
      // at the cheaper endpoint.
      await expect(
        service.checkResetCode('dara@itc.edu.kh', right),
      ).rejects.toThrow(/too many/i);
      expect(emailTokens.live).toHaveLength(0);
    });
  });

  describe('resend', () => {
    it('sends nothing for an address that is already confirmed', async () => {
      await register();
      await service.verifyEmailCode('dara@itc.edu.kh', codeFrom(sent[0]));

      const result = await service.resendVerification('dara@itc.edu.kh');
      expect(result.message).toMatch(/if that address needs confirming/i);
      expect(sent.filter((s) => s.kind === 'verify')).toHaveLength(1);
    });

    it('sends nothing for an address with no account, and says the same thing', async () => {
      const result = await service.resendVerification('nobody@itc.edu.kh');
      expect(result.message).toMatch(/if that address needs confirming/i);
      expect(sent).toHaveLength(0);
    });
  });
});
