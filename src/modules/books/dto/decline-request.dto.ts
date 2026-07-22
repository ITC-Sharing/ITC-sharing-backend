import { IsOptional, IsString, MaxLength } from 'class-validator';

export class DeclineRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}
