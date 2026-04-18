import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SupabaseService } from '../supabase/supabase.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private supabase: SupabaseService,
    private jwt: JwtService,
  ) {}

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
      })
      .select('id, first_name, last_name, email, role, major_id, created_at')
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

    // Strip password from response
    const { ...safeUser } = user;

    const token = this.signToken(user.id, user.email);

    return {
      user: { ...safeUser },
      token,
    };
  }

  private signToken(userId: string, email: string): string {
    return this.jwt.sign({ sub: userId, email });
  }
}
