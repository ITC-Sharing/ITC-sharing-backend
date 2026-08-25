import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { DepartmentModerator } from '../../entities/department-moderator.entity';
import { User } from '../../entities/user.entity';

/** Who the request is acting as, resolved once per call. */
export interface Reviewer {
  id: string;
  isAdmin: boolean;
  /** Departments this person moderates. Empty for a plain admin. */
  majorIds: string[];
}

/**
 * Answers "may this person review submissions for this department?".
 *
 * Two kinds of reviewer:
 *   - admins, who may review anything (so a department with no moderator is
 *     never stuck, and demoting the last moderator can't wedge the queue)
 *   - moderators, limited to the departments they're assigned to
 *
 * Authorization here is per RESOURCE, not per role: the department comes from
 * the upload or subject being actioned, never from the request. Every review
 * endpoint must call assertCanModerate() with the resource's major_id.
 */
@Injectable()
export class ModerationService {
  constructor(
    @InjectRepository(DepartmentModerator)
    private readonly moderators: Repository<DepartmentModerator>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  async resolveReviewer(userId: string): Promise<Reviewer> {
    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, role: true },
    });
    const isAdmin = user?.role?.toLowerCase() === 'admin';

    const rows = await this.moderators.find({
      where: { user_id: userId },
      select: { major_id: true },
    });

    return { id: userId, isAdmin, majorIds: rows.map((r) => r.major_id) };
  }

  /** True for an admin, or a moderator of that department. */
  canModerate(reviewer: Reviewer, majorId: string): boolean {
    return reviewer.isAdmin || reviewer.majorIds.includes(majorId);
  }

  assertCanModerate(reviewer: Reviewer, majorId: string) {
    if (!this.canModerate(reviewer, majorId)) {
      throw new ForbiddenException('You do not moderate this department');
    }
  }

  /**
   * Departments to scope a review queue to, or null for "no limit" (admin).
   * Null and [] mean different things: [] is a moderator of nothing, whose
   * queue must come back empty.
   */
  scopeMajorIds(reviewer: Reviewer): string[] | null {
    return reviewer.isAdmin ? null : reviewer.majorIds;
  }

  // ─── Assignment (admin only — guarded at the controller) ──────────────────

  async listByMajor(majorId: string) {
    const rows = await this.moderators.find({
      where: { major_id: majorId },
      relations: { user: true },
    });
    return rows.map((row) => ({
      id: row.user_id,
      first_name: row.user?.first_name ?? null,
      last_name: row.user?.last_name ?? null,
      email: row.user?.email ?? null,
      assigned_at: row.created_at,
    }));
  }

  /** Assignments for a set of users, keyed by user id — one query, not N. */
  async assignmentsByUser(userIds: string[]) {
    const byUser = new Map<string, { id: string; acronym: string }[]>();
    if (!userIds.length) return byUser;

    const rows = await this.moderators.find({
      where: { user_id: In(userIds) },
      relations: { major: true },
    });

    for (const row of rows) {
      const list = byUser.get(row.user_id) ?? [];
      list.push({ id: row.major_id, acronym: row.major?.acronym ?? '?' });
      byUser.set(row.user_id, list);
    }
    return byUser;
  }

  async assign(userId: string, majorId: string) {
    // Re-assigning is a no-op rather than an error: the admin's intent ("this
    // person moderates GIC") is already true.
    await this.moderators
      .createQueryBuilder()
      .insert()
      .values({ user_id: userId, major_id: majorId })
      .orIgnore()
      .execute();
    return { message: 'Moderator assigned' };
  }

  /** Strip every assignment — used when an account is banned. */
  async unassignAll(userId: string) {
    await this.moderators.delete({ user_id: userId });
  }

  async unassign(userId: string, majorId: string) {
    await this.moderators.delete({ user_id: userId, major_id: majorId });
    return { message: 'Moderator removed' };
  }

  /**
   * Departments with nobody assigned. Admins can still review them, so this is
   * a prompt rather than an error state — surfaced on the admin dashboard.
   */
  async majorsWithoutModerator() {
    const rows: { id: string; acronym: string; name: string }[] = await this
      .moderators.query(`
        select m.id, m.acronym, m.name
          from majors m
     left join department_moderators dm on dm.major_id = m.id
         where dm.major_id is null
      order by m.acronym
      `);
    return rows;
  }
}
