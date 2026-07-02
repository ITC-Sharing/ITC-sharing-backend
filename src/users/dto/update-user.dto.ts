import {
  IsString,
  IsOptional,
  IsUUID,
  IsInt,
  Min,
  Max,
  IsUrl,
  MaxLength,
} from 'class-validator';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  first_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  last_name?: string;

  @IsOptional()
  @IsUUID()
  major_id?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  year_level?: number;

  @IsOptional()
  @IsUrl()
  avatar_url?: string;
}
