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
// A subject's acronym: letters/numbers with no lowercase, e.g. WD, DS, A1.
// Letters are matched by Unicode class rather than [A-Z0-9] so a Khmer name can
// still produce one — scripts without case pass the "no lowercase" test.
export const SUBJECT_ACRONYM_PATTERN = /^(?!.*\p{Ll})[\p{L}\p{M}\p{N}]+$/u;

export class CreateSubjectDto {
  @IsUUID()
  major_id!: string;

  @IsString()
  @MaxLength(20)
  @Matches(SUBJECT_NAME_PATTERN, {
    message: 'Subject name must not contain special characters',
  })
  name!: string;

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
