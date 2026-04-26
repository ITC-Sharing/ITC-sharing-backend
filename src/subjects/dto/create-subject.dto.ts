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
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateSubjectDto {
  @IsUUID()
  major_id: string;

  @IsString()
  @MaxLength(80)
  name: string; // e.g. "Data Structures"

  @IsInt()
  @Type(() => Number)
  @Min(1)
  @Max(5)
  year_level: number;

  @IsInt()
  @Type(() => Number)
  @IsIn([1, 2])
  semester: number; // 1 or 2

  @IsOptional()
  @IsUrl()
  subject_url?: string;
}
