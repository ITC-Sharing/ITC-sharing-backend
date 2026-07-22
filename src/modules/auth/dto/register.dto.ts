import { Type } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  Max,
  Min,
  // Matches,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @IsString()
  @IsNotEmpty({ message: 'First name is required' })
  first_name: string;

  @IsString()
  @IsNotEmpty({ message: 'Last name is required' })
  last_name: string;

  @IsEmail({}, { message: 'Must be a valid email address' })
  // @Matches(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.edu(\.[a-zA-Z]{2,})?$/, {
  //   message: 'Only university .edu email addresses are accepted',
  // })
  email: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  password: string;

  @IsUUID('4', { message: 'Major must be a valid selection' })
  @IsNotEmpty({ message: 'Please select your major' })
  major_id: string;

  @Type(() => Number)
  @IsInt({ message: 'Please select your academic year' })
  @Min(1)
  @Max(5)
  year_level: number;
}
