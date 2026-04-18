import {
  IsString,
  IsUUID,
  IsInt,
  Min,
  Max,
  IsIn,
  MaxLength,
} from 'class-validator';

export class CreateSubjectDto {
  @IsUUID()
  major_id: string;

  @IsString()
  @MaxLength(50)
  name: string; // e.g. "Data Structures"

  @IsInt()
  @Min(1)
  @Max(5)
  year_level: number;

  @IsInt()
  @IsIn([1, 2])
  semester: number; // 1 or 2
}
