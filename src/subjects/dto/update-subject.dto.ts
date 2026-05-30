import { IsInt, IsIn, IsOptional, IsString, MaxLength, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateSubjectDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  @IsIn([1, 2])
  semester?: number;
}
