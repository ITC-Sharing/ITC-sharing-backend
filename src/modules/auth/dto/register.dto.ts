import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Institute student ID: the letter `e` then 8 digits, e.g. e20200123.
 * Exported because the frontend mirrors it to derive the email as you type, and
 * because deriveEmail() below is the only place the address is allowed to come
 * from — a client-supplied email would defeat the whole point of the OTP.
 */
export const STUDENT_ID_PATTERN = /^e\d{8}$/i;

/**
 * Institute student-mailbox domain. Every student ID maps to exactly one
 * address, e.g. e20220886 -> e20220886@dtc1.itc.edu.kh.
 *
 * Note this is the `dtc1.` subdomain, not the bare institute domain — student
 * mailboxes live there. Changing it here must be mirrored in RegisterView.vue,
 * which derives the same address client-side to fill the read-only field.
 */
export const STUDENT_EMAIL_DOMAIN = 'dtc1.itc.edu.kh';

export function deriveEmail(studentId: string): string {
  return `${studentId.trim().toLowerCase()}@${STUDENT_EMAIL_DOMAIN}`;
}

/**
 * Step 1 — details only. No password: the account does not exist yet, and
 * nothing is created until the code proves the address belongs to them.
 */
export class RegisterDto {
  @IsString()
  @IsNotEmpty({ message: 'First name is required' })
  first_name: string;

  @IsString()
  @IsNotEmpty({ message: 'Last name is required' })
  last_name: string;

  @IsString()
  @Matches(STUDENT_ID_PATTERN, {
    message: 'Student ID must be an "e" followed by 8 digits, e.g. e20200123',
  })
  student_id: string;

  @IsUUID('4', { message: 'Major must be a valid selection' })
  @IsNotEmpty({ message: 'Please select your major' })
  major_id: string;

  @Type(() => Number)
  @IsInt({ message: 'Please select your academic year' })
  @Min(1)
  @Max(5)
  year_level: number;
}

/** Step 2 — prove the address. */
export class VerifyOtpDto {
  @IsString()
  @Matches(STUDENT_ID_PATTERN, { message: 'Invalid student ID' })
  student_id: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'The code is 6 digits' })
  code: string;
}

/** Step 3 — set the password, which creates the account. */
export class SetPasswordDto {
  @IsString()
  @Matches(STUDENT_ID_PATTERN, { message: 'Invalid student ID' })
  student_id: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'The code is 6 digits' })
  code: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  password: string;
}

/** Ask for a new code. */
export class ResendOtpDto {
  @IsString()
  @Matches(STUDENT_ID_PATTERN, { message: 'Invalid student ID' })
  student_id: string;
}
