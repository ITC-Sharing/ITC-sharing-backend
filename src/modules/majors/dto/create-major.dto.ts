import {
  IsString,
  MaxLength,
  IsUrl,
  IsOptional,
  Matches,
} from 'class-validator';

// Letters (any language, incl. combining marks for Khmer), numbers, spaces and
// hyphens — and at least one letter/number. Mirrors SUBJECT_NAME_PATTERN.
export const MAJOR_NAME_PATTERN = /^(?=.*[\p{L}\p{N}])[\p{L}\p{M}\p{N}\s-]+$/u;
// Acronyms are uppercase letters/digits (GIC, AMS, GTR…).
export const MAJOR_ACRONYM_PATTERN = /^[A-Z0-9]+$/;

export class CreateMajorDto {
  @IsString()
  @MaxLength(100)
  @Matches(MAJOR_NAME_PATTERN, {
    message: 'Major name must not contain special characters',
  })
  name!: string;

  // Kept uppercase and unique: the frontend resolves a department page by
  // lowercasing this and matching it against the route slug, so two majors
  // sharing an acronym would make that lookup ambiguous.
  @IsString()
  @MaxLength(10)
  @Matches(MAJOR_ACRONYM_PATTERN, {
    message: 'Acronym must be uppercase letters and numbers only',
  })
  acronym!: string;

  @IsOptional()
  @IsUrl()
  image_url?: string;
}
