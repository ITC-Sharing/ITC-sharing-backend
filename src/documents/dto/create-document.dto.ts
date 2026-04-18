import {
  IsString,
  IsUUID,
  IsOptional,
  IsIn,
  IsArray,
  ArrayMaxSize,
  ArrayMinSize,
  MaxLength,
} from 'class-validator';

export const DOC_TYPES = ['notes', 'assignment', 'past_exam', 'lab'] as const;

export class CreateDocumentDto {
  @IsString()
  @MaxLength(150)
  title: string;

  @IsIn(DOC_TYPES)
  doc_type: (typeof DOC_TYPES)[number];

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
  @MaxLength(30, { each: true })
  tags?: string[]; // e.g. ["midterm", "2023", "prof-smith"]
}
