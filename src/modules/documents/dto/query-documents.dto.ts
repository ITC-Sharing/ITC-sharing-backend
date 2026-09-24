import {
  IsIn,
  IsOptional,
  IsUUID,
  IsEnum,
  IsString,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DocType } from './create-document.dto';

export class QueryDocumentsDto {
  @IsOptional()
  @IsUUID()
  major_id?: string;

  @IsOptional()
  @IsUUID()
  subject_id?: string;

  @IsOptional()
  @IsEnum(DocType)
  doc_type?: DocType;

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
  @Max(5)
  year_level?: number;

  @IsOptional()
  @IsString()
  academic_year?: string; // e.g. "2024-2025"

  // query-documents.dto.ts
  @IsOptional()
  @IsUUID()
  uploader_id?: string;

  /**
   * How the list is ordered. 'pinned' (the default) floats the viewer's pins to
   * the top, which is what a browse feed wants. 'date' is a plain reverse
   * chronology — the owner's own dashboard is a record of what they uploaded
   * and when, so a pin reordering it there makes the dates look wrong.
   */
  @IsOptional()
  @IsIn(['pinned', 'date'])
  sort?: 'pinned' | 'date';

  /**
   * Review state to list. Defaults to 'active' — the public feed.
   *
   * Anything other than 'active' is only honoured when listing your OWN
   * uploads (uploader_id === the caller); see findAll. Without that gate,
   * `?status=pending` would list every unreviewed upload in the institute.
   */
  @IsOptional()
  @IsIn(['pending', 'active', 'rejected'])
  status?: 'pending' | 'active' | 'rejected';

  /**
   * List only hidden uploads. Like `status`, honoured only when listing your
   * own — hiding is the uploader's switch, so nobody else may enumerate them.
   *
   * A string, not a boolean: query params arrive as text, and `Type(() =>
   * Boolean)` would turn the string "false" into `true`.
   */
  @IsOptional()
  @IsIn(['true', 'false'])
  hidden?: 'true' | 'false';

  /**
   * List only uploads whose expiry has passed.
   *
   * Not a `status` value: expiry is a date, and the row stays 'active' in the
   * database precisely so the owner keeps seeing it after it stops being
   * visible to anyone else. Making it a status would need a job to flip rows
   * and would break the visibility rules, which key off 'active'.
   *
   * Gated like `hidden` — only when listing your own, and only the owner's own
   * list returns expired uploads at all (see applyVisibility).
   */
  @IsOptional()
  @IsIn(['true', 'false'])
  expired?: 'true' | 'false';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
