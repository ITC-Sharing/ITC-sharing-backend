import {
  IsString,
  IsUUID,
  IsInt,
  Min,
  Max,
  IsIn,
  MaxLength,
  IsUrl,
  IsOptional,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';

// Letters (any language, incl. combining marks for Khmer), numbers, spaces and
// hyphens — and at least one letter/number.
export const SUBJECT_NAME_PATTERN =
  /^(?=.*[\p{L}\p{N}])[\p{L}\p{M}\p{N}\s-]+$/u;
// Lowercase kebab-case: letters/numbers split by single hyphens.
export const SUBJECT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateSubjectDto {
  @IsUUID()
  major_id!: string;

  @IsString()
  @MaxLength(80)
  @Matches(SUBJECT_NAME_PATTERN, {
    message: 'Subject name must not contain special characters',
  })
  name!: string;

  @IsString()
  @MaxLength(80)
  @Matches(SUBJECT_SLUG_PATTERN, {
    message:
      'Slug can only contain lowercase letters, numbers and single hyphens',
  })
  slug!: string;

  @IsInt()
  @Type(() => Number)
  @Min(1)
  @Max(5)
  year_level!: number;

  @IsInt()
  @Type(() => Number)
  @IsIn([1, 2])
  semester!: number;

  @IsOptional()
  @IsUrl()
  subject_url?: string;
}
