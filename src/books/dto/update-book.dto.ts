import { IsString, IsUUID, MaxLength } from 'class-validator';

export class UpdateBookDto {
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsUUID('4', { message: 'Department must be a valid selection' })
  department?: string;

  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsString()
  @MaxLength(200)
  contact?: string;

  @IsString()
  @MaxLength(2000)
  cover_image_url?: string;
}
