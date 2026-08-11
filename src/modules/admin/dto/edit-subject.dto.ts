import {
  IsInt,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  SUBJECT_ACRONYM_PATTERN,
  SUBJECT_NAME_PATTERN,
} from '../../subjects/dto/create-subject.dto';

// Admin edit of an existing subject — name, acronym and/or semester. Everyone
// else gets the acronym derived from the name; this is the only way to override
// it.
export class EditSubjectDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(SUBJECT_NAME_PATTERN, {
    message: 'Subject name must not contain special characters',
  })
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  @Matches(SUBJECT_ACRONYM_PATTERN, {
    message: 'Acronym can only contain letters and numbers, with no lowercase',
  })
  acronym?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  @IsIn([1, 2])
  semester?: number;
}
