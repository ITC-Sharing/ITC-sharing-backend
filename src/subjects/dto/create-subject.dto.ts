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
  major_id!: string;

  @IsString()
  @MaxLength(80)
  name!: string;

  @IsString()
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
