import { IsString, MaxLength, IsUrl, IsOptional, Matches } from 'class-validator';
import { MAJOR_ACRONYM_PATTERN, MAJOR_NAME_PATTERN } from './create-major.dto';

/**
 * Every field optional — the form sends only what changed, and a multipart
 * request can carry just a new logo.
 */
export class UpdateMajorDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(MAJOR_NAME_PATTERN, {
    message: 'Major name must not contain special characters',
  })
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  @Matches(MAJOR_ACRONYM_PATTERN, {
    message: 'Acronym must be uppercase letters and numbers only',
  })
  acronym?: string;

  @IsOptional()
  @IsUrl()
  image_url?: string;
}
