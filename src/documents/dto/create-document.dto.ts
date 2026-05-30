import { Type } from 'class-transformer';
import {
  IsString,
  IsUUID,
  IsOptional,
  IsIn,
  IsArray,
  ArrayMaxSize,
  ArrayMinSize,
  MaxLength,
  IsInt,
  Min,
  Max,
} from 'class-validator';

export const DOC_TYPES = [
  'notes',
  'assignment',
  'past_exam',
  'lab',
  'lesson',
] as const;

export class CreateDocumentDto {
  @IsString()
  @MaxLength(150)
  title?: string;

  @IsIn(DOC_TYPES)
  doc_type: (typeof DOC_TYPES)[number];

  @IsUUID()
  major_id: string;

  @IsUUID()
  subject_id?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ArrayMinSize(1)
  @IsString({ each: true })
  @MaxLength(30, { each: true })
  tags?: string[]; // e.g. ["midterm", "2023", "prof-smith"]

  @IsInt()
  @Type(() => Number)
  @Min(1)
  @Max(5)
  year_level: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  academic_year?: string;
}
