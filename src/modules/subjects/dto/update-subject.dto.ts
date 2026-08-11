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

// The acronym isn't here on purpose: it's derived from the name (renaming
// re-derives it), and only an admin can override it — see EditSubjectDto.
export class UpdateSubjectDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(SUBJECT_NAME_PATTERN, {
    message: 'Subject name must not contain special characters',
  })
  name?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  @IsIn([1, 2])
  semester?: number;
}
