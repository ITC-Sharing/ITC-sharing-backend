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
} from 'class-validator';

export enum DocType {
  Note = 'Note',
  TD = 'TD',
  ExaminationPaper = 'Examination paper',
  TP = 'TP',
  Project = 'Project',
  Lesson = 'Lesson',
  Other = 'Other',
}

export const DOC_TYPES = Object.values(DocType);

export class CreateDocumentDto {
  @IsString()
  @MaxLength(150)
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
  @MaxLength(30, { each: true })
  tags?: string[];

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
