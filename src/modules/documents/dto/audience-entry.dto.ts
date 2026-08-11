import { IsInt, IsUUID, Max, Min } from 'class-validator';

/**
 * One department + year that may see an upload. The form adds these one at a
 * time — pick a department, pick a year — so "GIC year 3" is stored as exactly
 * that, not as an intersection of two independent lists.
 */
export class AudienceEntryDto {
  @IsUUID()
  major_id!: string;

  @IsInt()
  @Min(1)
  @Max(5)
  year_level!: number;
}
