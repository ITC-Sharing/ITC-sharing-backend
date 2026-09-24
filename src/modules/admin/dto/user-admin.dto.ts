import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

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

/**
 * Move a student to a different department and year.
 *
 * Students cannot do this to themselves — the pair decides which documents they
 * can see, so PATCH /users/me refuses it once their profile is set. Placement
 * is the institute's call, which makes this an admin-only correction.
 */
export class SetUserPlacementDto {
  @IsUUID('4', { message: 'Department must be a valid selection' })
  major_id!: string;

  @Type(() => Number)
  @IsInt({ message: 'Year must be a whole number' })
  @Min(1)
  @Max(5)
  year_level!: number;
}
