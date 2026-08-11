import { Transform } from 'class-transformer';
import { IsArray, IsOptional, IsUUID } from 'class-validator';
import { parseJsonArray } from './create-document.dto';

/**
 * Body of POST /documents/:id/files. The files themselves may arrive as
 * multipart, or as ids of files the form staged earlier — same two routes in as
 * a new upload.
 */
export class AddFilesDto {
  @IsOptional()
  @Transform(parseJsonArray)
  @IsArray()
  @IsUUID('4', { each: true })
  staged_file_ids?: string[];
}
