import { IsOptional, IsUUID, IsIn, IsString } from 'class-validator';
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
}
