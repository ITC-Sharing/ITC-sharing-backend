import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateRequestDto {
  @IsString()
  @IsOptional()
  @MaxLength(500)
  message?: string;

  @IsString()
  @IsNotEmpty({ message: 'Contact is required so the donor can reach you' })
  @MaxLength(200)
  contact!: string;
}
