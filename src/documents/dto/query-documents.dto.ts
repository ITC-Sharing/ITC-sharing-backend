import {
  IsOptional,
  IsUUID,
  IsIn,
  IsString,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DOC_TYPES } from './create-document.dto';

export class QueryDocumentsDto {
  @IsOptional()
  @IsUUID()
  major_id?: string;

  @IsOptional()
  @IsUUID()
  subject_id?: string;

  @IsOptional()
  @IsIn(DOC_TYPES)
  doc_type?: (typeof DOC_TYPES)[number];

  @IsOptional()
  @IsString()
  search?: string; // matches against title

  @IsOptional()
  @IsString()
  title?: string; // exact title match

  @IsOptional()
  @IsUUID()
  group_id?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  year_level?: number;

  @IsOptional()
  @IsString()
  academic_year?: string; // e.g. "2024-2025"

  // query-documents.dto.ts
  @IsOptional()
  @IsUUID()
  uploader_id?: string;
}
