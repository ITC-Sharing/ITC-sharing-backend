import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ModerationService, Reviewer } from '../moderation.service';

/** The request, once this guard has resolved who's reviewing. */
export interface ReviewerRequest {
  user?: { sub?: string };
  reviewer?: Reviewer;
}

/**
 * Lets admins and department moderators through, and attaches the resolved
 * reviewer to the request so handlers don't look it up again.
 *
 * Passing this guard means "you review something"; it does NOT mean you may
 * review the resource in the URL. Each handler still calls assertCanModerate()
 * with that resource's department — the guard can't, because it doesn't know
 * which upload or subject is being actioned.
 */
@Injectable()
export class ReviewerGuard implements CanActivate {
  constructor(private readonly moderation: ModerationService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ReviewerRequest>();
    const userId = request.user?.sub;
    if (!userId) return false;

    const reviewer = await this.moderation.resolveReviewer(userId);
    if (!reviewer.isAdmin && reviewer.majorIds.length === 0) {
      throw new ForbiddenException('Reviewer access required');
    }

    request.reviewer = reviewer;
    return true;
  }
}
