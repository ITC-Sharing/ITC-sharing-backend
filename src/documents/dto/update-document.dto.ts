import { Type } from 'class-transformer';
import {
  IsString,
  IsUUID,
  IsOptional,
  IsEnum,
  IsArray,
  ArrayMaxSize,
  MaxLength,
  IsInt,
  Min,
  Max,
  Matches,
} from 'class-validator';
import { DocType } from './create-document.dto';

// Letters (any language, incl. Khmer marks), numbers, spaces and hyphens.
const TITLE_PATTERN = /^(?=.*[\p{L}\p{N}])[\p{L}\p{M}\p{N}\s-]+$/u;
const TAG_PATTERN = /^[\p{L}\p{M}\p{N}]+(?:-[\p{L}\p{M}\p{N}]+)*$/u;

// Metadata-only edit of an existing upload (files are not changed here).
export class UpdateDocumentDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(TITLE_PATTERN, {
    message: 'Title must not contain special characters',
  })
  title?: string;

  @IsOptional()
  @IsEnum(DocType)
  doc_type?: DocType;

  @IsOptional()
  @IsUUID()
  major_id?: string;

  @IsOptional()
  @IsUUID()
  subject_id?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  @MaxLength(10, { each: true })
  @Matches(TAG_PATTERN, {
    each: true,
    message: 'Tags can only contain letters, numbers and hyphens',
  })
  tags?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  year_level?: number;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  academic_year?: string;
}
