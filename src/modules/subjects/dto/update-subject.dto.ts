import {
  IsInt,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SUBJECT_NAME_PATTERN } from './create-subject.dto';
import { SUBJECT_SLUG_PATTERN } from './create-subject.dto';

export class UpdateSubjectDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(SUBJECT_NAME_PATTERN, {
    message: 'Subject name must not contain special characters',
  })
  name?: string;

  @IsString()
  @MaxLength(10)
  @Matches(SUBJECT_SLUG_PATTERN, {
    message:
      'Slug can only contain lowercase letters, numbers and single hyphens',
  })
  slug!: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  @IsIn([1, 2])
  semester?: number;
}
