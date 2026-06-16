import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateBookDto {
  @IsString()
  @IsNotEmpty({ message: 'Title is required' })
  @MaxLength(200)
  title!: string;

  @IsUUID('4', { message: 'Department must be a valid selection' })
  @IsNotEmpty({ message: 'Please select a department' })
  department!: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @IsString()
  @IsNotEmpty({ message: 'Contact is required' })
  @MaxLength(200)
  contact!: string;

  @IsString()
  @IsNotEmpty({ message: 'Cover image is required' })
  @MaxLength(2000)
  cover_image_url!: string;
}
