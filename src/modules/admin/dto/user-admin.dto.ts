import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** Promote to admin or demote back. Moderator is an assignment, not a role. */
export class SetUserRoleDto {
  @IsIn(['user', 'admin'])
  role!: 'user' | 'admin';
}

export class BanUserDto {
  /** Shown to the user when they try to sign in. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
