import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../../entities/user.entity';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      user?: { sub?: string };
    }>();
    const userId = request.user?.sub;

    if (!userId) return false;

    const user = await this.users.findOne({
      where: { id: userId },
      select: { role: true },
    });

    if (user?.role?.toLowerCase() !== 'admin') {
      throw new ForbiddenException('Admin access required');
    }

    return true;
  }
}
