import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Matches,
} from 'class-validator';

// Letters (any language, incl. Khmer marks), numbers, spaces and hyphens —
// at least one letter/number. No special characters.
const TITLE_PATTERN = /^(?=.*[\p{L}\p{N}])[\p{L}\p{M}\p{N}\s-]+$/u;
// Free text that simply must not contain template-injection characters.
const NO_FORBIDDEN_PATTERN = /^[^${}]*$/;
const FORBIDDEN_MESSAGE = 'Must not contain $, { or }';

export class CreateBookDto {
  @IsString()
  @IsNotEmpty({ message: 'Title is required' })
  @MaxLength(200)
  @Matches(TITLE_PATTERN, {
    message: 'Title must not contain special characters',
  })
  title!: string;

  @IsUUID('4', { message: 'Department must be a valid selection' })
  @IsNotEmpty({ message: 'Please select a department' })
  department!: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  @Matches(NO_FORBIDDEN_PATTERN, { message: FORBIDDEN_MESSAGE })
  description?: string;

  @IsString()
  @IsNotEmpty({ message: 'Contact is required' })
  @MaxLength(200)
  @Matches(NO_FORBIDDEN_PATTERN, { message: FORBIDDEN_MESSAGE })
  contact!: string;

  @IsString()
  @IsNotEmpty({ message: 'Cover image is required' })
  @MaxLength(2000)
  cover_image_url!: string;
}
