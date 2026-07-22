import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Matches,
} from 'class-validator';

// Letters (any language, incl. Khmer marks), numbers, spaces and hyphens.
const TITLE_PATTERN = /^(?=.*[\p{L}\p{N}])[\p{L}\p{M}\p{N}\s-]+$/u;
// Free text that simply must not contain template-injection characters.
const NO_FORBIDDEN_PATTERN = /^[^${}]*$/;
const FORBIDDEN_MESSAGE = 'Must not contain $, { or }';

export class UpdateBookDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(TITLE_PATTERN, {
    message: 'Title must not contain special characters',
  })
  title?: string;

  @IsOptional()
  @IsUUID('4', { message: 'Department must be a valid selection' })
  department?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Matches(NO_FORBIDDEN_PATTERN, { message: FORBIDDEN_MESSAGE })
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(NO_FORBIDDEN_PATTERN, { message: FORBIDDEN_MESSAGE })
  contact?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  cover_image_url?: string;
}
