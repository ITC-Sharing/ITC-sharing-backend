import {
  IsInt,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  Max,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SUBJECT_NAME_PATTERN } from './create-subject.dto';

export class UpdateSubjectDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
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
