import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly supabaseService: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const userId: string | undefined = request.user?.sub;

    if (!userId) return false;

    const { data } = await this.supabaseService
      .getClient()
      .from('users')
      .select('role')
      .eq('id', userId)
      .single();

    if (data?.role !== 'admin') {
      throw new ForbiddenException('Admin access required');
    }

    return true;
  }
}
