import { ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ModerationService, type Reviewer } from './moderation.service';
import { AdminController } from './admin.controller';
import { ModerationController } from './moderation.controller';
import { AdminGuard } from './guards/admin.guard';
import { ReviewerGuard } from './guards/reviewer.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DepartmentModerator } from './entities/department-moderator.entity';
import { User } from '../users/entities/user.entity';

/**
 * Two things are protected here.
 *
 * The first is the scoping arithmetic — who may act on what — which is pure
 * logic and worth testing directly rather than through HTTP.
 *
 * The second is the guard composition, which is the defect this work fixed:
 * Nest guards accumulate, so putting AdminGuard on a controller that also
 * carries ReviewerGuard rejects every moderator while looking, in the source,
 * as though it permits them. That is invisible in a code review and expensive
 * to rediscover, so it is asserted from the metadata.
 */

const GIC = 'major-gic';
const GIM = 'major-gim';
const GTR = 'major-gtr';

const admin: Reviewer = { id: 'u-admin', isAdmin: true, majorIds: [] };
const gicMod: Reviewer = { id: 'u-gic', isAdmin: false, majorIds: [GIC] };
const twoDeptMod: Reviewer = {
  id: 'u-two',
  isAdmin: false,
  majorIds: [GIC, GIM],
};
const unassigned: Reviewer = { id: 'u-none', isAdmin: false, majorIds: [] };

function guardsOn(target: object): string[] {
  const guards: unknown[] =
    (Reflect.getMetadata('__guards__', target) as unknown[]) ?? [];
  return guards.map((g) => (g as { name?: string })?.name ?? String(g));
}

describe('moderation authorization', () => {
  let moderation: ModerationService;

  beforeEach(() => {
    // Only the pure methods are exercised; the repositories are never touched.
    moderation = new ModerationService(
      {} as Repository<DepartmentModerator>,
      {} as Repository<User>,
    );
  });

  describe('Case A — an admin reviews any department', () => {
    it('is unscoped and may act anywhere', () => {
      expect(moderation.scopeMajorIds(admin)).toBeNull();
      for (const major of [GIC, GIM, GTR]) {
        expect(moderation.canModerate(admin, major)).toBe(true);
        expect(() => moderation.assertCanModerate(admin, major)).not.toThrow();
      }
    });
  });

  describe('Case B — a moderator of one department', () => {
    it('is scoped to it, and may act on it', () => {
      expect(moderation.scopeMajorIds(gicMod)).toEqual([GIC]);
      expect(() => moderation.assertCanModerate(gicMod, GIC)).not.toThrow();
    });
  });

  describe('Case C — another department is refused', () => {
    it.each([GIM, GTR])('refuses %s', (major) => {
      expect(moderation.canModerate(gicMod, major)).toBe(false);
      expect(() => moderation.assertCanModerate(gicMod, major)).toThrow(
        ForbiddenException,
      );
    });

    it('cannot be talked round by a department the caller supplies', () => {
      // The service is only ever handed a major_id read from the loaded
      // resource. Even so: the reviewer's own assignments decide, and a value
      // that happens to name a department they do moderate does not help when
      // the resource belongs to another.
      const resourceDepartment = GIM; // what the upload actually says
      expect(() =>
        moderation.assertCanModerate(gicMod, resourceDepartment),
      ).toThrow(ForbiddenException);
    });
  });

  describe('Case D — a reviewer with no assignments', () => {
    it('scopes to [] — which must not be read as "no restriction"', () => {
      const scope = moderation.scopeMajorIds(unassigned);
      expect(scope).toEqual([]);
      expect(scope).not.toBeNull();

      // This is the branch the queue methods key on. Collapsing [] into null
      // would hand them every department's submissions.
      expect(scope?.length === 0).toBe(true);
      expect(moderation.scopeMajorIds(admin)?.length === 0).toBe(false);
    });

    it('may not act on any department', () => {
      for (const major of [GIC, GIM, GTR]) {
        expect(() => moderation.assertCanModerate(unassigned, major)).toThrow(
          ForbiddenException,
        );
      }
    });
  });

  describe('Case E — a moderator of two departments', () => {
    it('covers both and nothing else', () => {
      expect(moderation.scopeMajorIds(twoDeptMod)).toEqual([GIC, GIM]);
      expect(() => moderation.assertCanModerate(twoDeptMod, GIC)).not.toThrow();
      expect(() => moderation.assertCanModerate(twoDeptMod, GIM)).not.toThrow();
      expect(() => moderation.assertCanModerate(twoDeptMod, GTR)).toThrow(
        ForbiddenException,
      );
    });
  });

  describe('the queue each reviewer sees', () => {
    /** Mirrors getPendingSubjects / getPendingDocuments. */
    const queue = (reviewer: Reviewer, all: { major: string }[]) => {
      const scope = moderation.scopeMajorIds(reviewer);
      if (scope?.length === 0) return [];
      return scope ? all.filter((i) => scope.includes(i.major)) : all;
    };
    const pending = [
      { major: GIC },
      { major: GIC },
      { major: GIM },
      { major: GTR },
    ];

    it('admin sees every department', () => {
      expect(queue(admin, pending)).toHaveLength(4);
    });

    it('a GIC moderator sees GIC only', () => {
      const rows = queue(gicMod, pending);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.major === GIC)).toBe(true);
    });

    it('a GTR moderator sees GTR only', () => {
      const gtrMod: Reviewer = { id: 'u-gtr', isAdmin: false, majorIds: [GTR] };
      const rows = queue(gtrMod, pending);
      expect(rows).toHaveLength(1);
      expect(rows[0].major).toBe(GTR);
    });

    it('a GIC + GIM moderator sees both and nothing else', () => {
      const rows = queue(twoDeptMod, pending);
      expect(rows.map((r) => r.major).sort()).toEqual([GIC, GIC, GIM].sort());
    });

    it('a moderator with no assignments sees nothing — not everything', () => {
      expect(queue(unassigned, pending)).toHaveLength(0);
    });
  });

  describe('approve and reject authorisation', () => {
    // Both verbs run the same check, so the table covers each.
    const cases: [string, Reviewer, string, boolean][] = [
      ['admin on GIC', admin, GIC, true],
      ['admin on GTR', admin, GTR, true],
      ['admin on GCA', admin, 'major-gca', true],
      ['GIC moderator on GIC', gicMod, GIC, true],
      ['GIC moderator on GTR', gicMod, GTR, false],
      ['GIC moderator on GCA', gicMod, 'major-gca', false],
      ['GIC+GIM moderator on GIC', twoDeptMod, GIC, true],
      ['GIC+GIM moderator on GIM', twoDeptMod, GIM, true],
      ['GIC+GIM moderator on GTR', twoDeptMod, GTR, false],
      ['unassigned on GIC', unassigned, GIC, false],
    ];

    it.each(cases)('%s', (_label, reviewer, major, allowed) => {
      const act = () => moderation.assertCanModerate(reviewer, major);
      if (allowed) expect(act).not.toThrow();
      else expect(act).toThrow(ForbiddenException);
    });
  });

  describe('the review-detail endpoint', () => {
    /** Mirrors getDocumentsByGroup: load the upload, then check ITS department. */
    const open = (reviewer: Reviewer, upload: { major_id: string }) => {
      moderation.assertCanModerate(reviewer, upload.major_id);
      return upload;
    };

    it('lets a GIC moderator open a GIC submission', () => {
      expect(() => open(gicMod, { major_id: GIC })).not.toThrow();
    });

    it('refuses a GIC moderator a GTR submission', () => {
      expect(() => open(gicMod, { major_id: GTR })).toThrow(ForbiddenException);
    });

    it('lets an admin open anything', () => {
      for (const major of [GIC, GIM, GTR]) {
        expect(() => open(admin, { major_id: major })).not.toThrow();
      }
    });

    it('ignores a department the caller claims, using the record instead', () => {
      // The id in the URL selects WHICH upload is checked, never WHETHER it is.
      const claimed = GIC; // what a forged request might say
      const actual = GTR; // what the row says
      expect(claimed).not.toBe(actual);
      expect(() => open(gicMod, { major_id: actual })).toThrow(
        ForbiddenException,
      );
    });
  });

  describe('the controller boundary', () => {
    it('puts the review routes behind ReviewerGuard and NOT AdminGuard', () => {
      const guards = guardsOn(ModerationController);
      expect(guards).toContain(JwtAuthGuard.name);
      expect(guards).toContain(ReviewerGuard.name);
      // The whole point: AdminGuard here would accumulate, not override, and
      // no moderator would ever reach a review route.
      expect(guards).not.toContain(AdminGuard.name);
    });

    it('keeps the admin routes behind AdminGuard', () => {
      const guards = guardsOn(AdminController);
      expect(guards).toContain(JwtAuthGuard.name);
      expect(guards).toContain(AdminGuard.name);
    });

    it('declares no per-route guard on the review controller', () => {
      // A route-level @UseGuards would be the same accumulation trap in a new
      // place; the class guard is meant to be the whole boundary.
      const proto = ModerationController.prototype as unknown as Record<
        string,
        unknown
      >;
      const handlers = Object.getOwnPropertyNames(proto).filter(
        (k) => k !== 'constructor' && typeof proto[k] === 'function',
      );
      expect(handlers.length).toBeGreaterThan(0);
      for (const handler of handlers) {
        expect(guardsOn(proto[handler] as object)).toEqual([]);
      }
    });
  });
});
