import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateRequestDto {
  @IsString()
  @IsNotEmpty({ message: 'Message is required' })
  @MaxLength(500)
  message!: string;
}
