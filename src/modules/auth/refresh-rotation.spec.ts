import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'crypto';
import { AuthService } from './auth.service';
import { User } from '../users/entities/user.entity';

/**
 * Refresh-token rotation, reuse detection, and the one case they conflict on.
 *
 * Driven through a fake repository rather than a mock, because what is worth
 * protecting here is state over time — which row is consumed, which family
 * survives, what a second presentation of the same token does. A mock would
 * assert that delete() was called, which was never the part in doubt.
 */

const REFRESH_SECRET = 'refresh-secret-for-rotation-specs';
const ACCESS_SECRET = 'access-secret-for-rotation-specs';

interface Row {
  id: string;
  user_id: string;
  token_hash: string;
  family_id: string;
  consumed_at: Date | null;
  expires_at: Date;
}

/**
 * Enough of TypeORM's Repository for this flow. `update` honours the
 * `consumed_at: IsNull()` predicate, because the atomic claim is the mechanism
 * under test — a fake that ignored it would pass while the real race failed.
 */
class FakeTokenRepo {
  rows: Row[] = [];
  private seq = 0;

  create(partial: Partial<Row>): Row {
    return { id: `row-${++this.seq}`, ...partial } as Row;
  }

  save(row: Row): Promise<Row> {
    this.rows.push(row);
    return Promise.resolve(row);
  }

  findOne(options: {
    where: { token_hash?: string; id?: string };
  }): Promise<Row | null> {
    const { token_hash, id } = options.where;
    const found = this.rows.find(
      (r) =>
        (token_hash === undefined || r.token_hash === token_hash) &&
        (id === undefined || r.id === id),
    );
    // A copy: the service holds the row across an await, and a live reference
    // would let it see a consumed_at written after it read.
    return Promise.resolve(found ? { ...found } : null);
  }

  update(
    criteria: { id: string; consumed_at?: unknown },
    patch: { consumed_at: Date },
  ): Promise<{ affected: number }> {
    const wantsUnconsumed = criteria.consumed_at !== undefined;
    const target = this.rows.find(
      (r) =>
        r.id === criteria.id && (!wantsUnconsumed || r.consumed_at === null),
    );
    if (!target) return Promise.resolve({ affected: 0 });
    target.consumed_at = patch.consumed_at;
    return Promise.resolve({ affected: 1 });
  }

  delete(criteria: { family_id?: string }): Promise<{ affected: number }> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.family_id !== criteria.family_id);
    return Promise.resolve({ affected: before - this.rows.length });
  }

  get live(): Row[] {
    return this.rows.filter((r) => r.consumed_at === null);
  }
}

describe('refresh token rotation', () => {
  let tokens: FakeTokenRepo;
  let service: AuthService;
  let jwt: JwtService;
  let banned: Date | null;

  const USER_ID = '11111111-1111-4111-8111-111111111111';

  const configWith = (grace?: string) =>
    ({
      get: (key: string) =>
        key === 'REFRESH_REUSE_GRACE_SECONDS' ? grace : undefined,
      getOrThrow: (key: string) =>
        key === 'JWT_REFRESH_SECRET'
          ? REFRESH_SECRET
          : key === 'JWT_REFRESH_SECRET_EXPIRATION_IN'
            ? '7d'
            : undefined,
    }) as unknown as ConfigService;

  const users = {
    findOne: () =>
      Promise.resolve({
        id: USER_ID,
        email: 'student@itc.edu.kh',
        banned_at: banned,
      } as User),
  };

  /** A signed refresh token with a row to match, as login would leave behind. */
  async function issue(familyId = 'family-1'): Promise<string> {
    const raw = jwt.sign(
      { sub: USER_ID, jti: `${Math.random()}` },
      { secret: REFRESH_SECRET, expiresIn: '7d' },
    );
    await tokens.save(
      tokens.create({
        user_id: USER_ID,
        token_hash: hash(raw),
        family_id: familyId,
        consumed_at: null,
        expires_at: new Date(Date.now() + 86_400_000),
      }),
    );
    return raw;
  }

  function hash(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  function build(grace?: string) {
    tokens = new FakeTokenRepo();
    service = new AuthService(
      users as never,
      tokens as unknown as never,
      // The email-token repository and the mailer take no part in rotation.
      // Stubbed rather than faked: a test that needed them would be testing a
      // different thing.
      {} as never,
      jwt,
      configWith(grace),
      {} as never,
      { refreshReuse: () => undefined } as never,
    );
  }

  beforeEach(() => {
    banned = null;
    jwt = new JwtService({ secret: ACCESS_SECRET });
    build();
  });

  it('rotates: the redeemed token is consumed, not deleted, and a child joins its family', async () => {
    const first = await issue();

    const { refreshToken: second } = await service.refresh(first);

    expect(second).not.toBe(first);
    // Kept on purpose — a deleted row is indistinguishable from one that never
    // existed, which is the whole reason replay used to be invisible.
    expect(tokens.rows).toHaveLength(2);
    expect(tokens.rows[0].consumed_at).toBeInstanceOf(Date);
    expect(tokens.live).toHaveLength(1);
    expect(tokens.rows.every((r) => r.family_id === 'family-1')).toBe(true);
  });

  it('lets two tabs race on the same cookie — both are the same person', async () => {
    const shared = await issue();

    // Genuinely concurrent: neither await resolves before the other starts.
    const [a, b] = await Promise.all([
      service.refresh(shared),
      service.refresh(shared),
    ]);

    expect(a.refreshToken).not.toBe(b.refreshToken);
    expect(tokens.live).toHaveLength(2);
    // Nothing was revoked: the family is intact.
    expect(tokens.rows).toHaveLength(3);
  });

  it('treats a replay after the grace window as reuse and kills the whole family', async () => {
    const stolen = await issue();
    const { refreshToken: current } = await service.refresh(stolen);

    // The thief comes back later with the copy they kept.
    tokens.rows[0].consumed_at = new Date(Date.now() - 60_000);

    await expect(service.refresh(stolen)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    // Not just the replayed token: the descendant the victim is holding goes
    // too. Leaving it would sign out the victim and leave the thief signed in.
    expect(tokens.rows).toHaveLength(0);
    await expect(service.refresh(current)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('says only "revoked" on reuse, never that the token was recognised', async () => {
    const stolen = await issue();
    await service.refresh(stolen);
    tokens.rows[0].consumed_at = new Date(Date.now() - 60_000);

    await expect(service.refresh(stolen)).rejects.toThrow(
      'Refresh token has been revoked',
    );
  });

  it('leaves other families alone', async () => {
    const phone = await issue('family-phone');
    const laptop = await issue('family-laptop');

    await service.refresh(phone);
    tokens.rows[0].consumed_at = new Date(Date.now() - 60_000);
    await expect(service.refresh(phone)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    // Signing out of a stolen session must not sign out the other device.
    const stillWorks = await service.refresh(laptop);
    expect(stillWorks.accessToken).toBeTruthy();
  });

  it('treats every replay as reuse when the grace window is zero', async () => {
    build('0');
    const raw = await issue();
    await service.refresh(raw);

    await expect(service.refresh(raw)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(tokens.rows).toHaveLength(0);
  });

  it('clamps an over-long grace window rather than honouring it', async () => {
    build('99999');
    const raw = await issue();
    await service.refresh(raw);
    // 61 s ago: inside the configured 99999 s, outside the 60 s ceiling.
    tokens.rows[0].consumed_at = new Date(Date.now() - 61_000);

    await expect(service.refresh(raw)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refuses a banned account even holding a valid token', async () => {
    const raw = await issue();
    banned = new Date();

    await expect(service.refresh(raw)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('logout revokes the family, not just the token presented', async () => {
    const first = await issue();
    const { refreshToken: second } = await service.refresh(first);

    await service.logout(second);

    expect(tokens.rows).toHaveLength(0);
    await expect(service.refresh(first)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
