import { IsEmail, IsString, Matches, MinLength } from 'class-validator';

/**
 * Confirming an address with the emailed code.
 *
 * The email is part of the request because a bcrypt hash has a per-row salt —
 * there is nothing to look a code up by, so the address names the row and the
 * code is compared against it. It also means a code issued for one account
 * cannot be typed into another.
 *
 * Shape-checked here so six digits is the only thing that reaches bcrypt: a
 * compare costs ~100ms, and anything that is not a code should be refused
 * before it can buy that.
 */
export class VerifyCodeDto {
  @IsEmail({}, { message: 'Enter a valid email address' })
  email: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code from your email' })
  code: string;
}

/** Asking for a link to be sent. Used by both resend-verification and forgot-password. */
export class EmailDto {
  @IsEmail({}, { message: 'Enter a valid email address' })
  email: string;
}

export class ResetPasswordDto {
  /** Names the row, exactly as in VerifyCodeDto — bcrypt salts per row. */
  @IsEmail({}, { message: 'Enter a valid email address' })
  email: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code from your email' })
  code: string;

  /**
   * Same floor as registration. A reset that accepted a weaker password than
   * sign-up would be a way around the rule rather than a way back in.
   */
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  password: string;
}
