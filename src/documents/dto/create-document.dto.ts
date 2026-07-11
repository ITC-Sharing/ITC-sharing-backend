import { Type } from 'class-transformer';
import {
  IsString,
  IsUUID,
  IsOptional,
  IsEnum,
  IsArray,
  ArrayMaxSize,
  ArrayMinSize,
  MaxLength,
  IsInt,
  Min,
  Max,
  Matches,
} from 'class-validator';

export enum DocType {
  Note = 'Note',
  TD = 'TD',
  ExaminationPaper = 'Examination paper',
  TP = 'TP',
  Project = 'Project',
  Lesson = 'Lesson',
  Thesis = 'Thesis',
  Other = 'Other',
}

export const DOC_TYPES = Object.values(DocType);

// Letters (any language, incl. Khmer marks), numbers, spaces and hyphens —
// at least one letter/number. No special characters.
const TITLE_PATTERN = /^(?=.*[\p{L}\p{N}])[\p{L}\p{M}\p{N}\s-]+$/u;
// A single tag — letters/numbers (any language) joined by single hyphens.
const TAG_PATTERN = /^[\p{L}\p{M}\p{N}]+(?:-[\p{L}\p{M}\p{N}]+)*$/u;

export class CreateDocumentDto {
  @IsString()
  @MaxLength(20)
  @Matches(TITLE_PATTERN, {
    message: 'Title must not contain special characters',
  })
  title?: string;

  @IsEnum(DocType)
  doc_type: DocType;

  @IsUUID()
  major_id: string;

  @IsOptional()
  @IsUUID()
  subject_id?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ArrayMinSize(1)
  @IsString({ each: true })
  @MaxLength(10, { each: true })
  @Matches(TAG_PATTERN, {
    each: true,
    message: 'Tags can only contain letters, numbers and hyphens',
  })
  tags?: string[];

  @IsInt()
  @Type(() => Number)
  @Min(1)
  @Max(5)
  year_level: number;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  academic_year?: string;
}
