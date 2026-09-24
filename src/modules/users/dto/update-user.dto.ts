import {
  Matches,
  IsArray,
  ArrayMaxSize,
  IsString,
  IsOptional,
  IsUUID,
  IsInt,
  Min,
  Max,
  IsUrl,
  MaxLength,
} from 'class-validator';

/**
 * Same rule as registration — see RegisterDto for why the Khmer block sits in
 * the first position too. Enforced here as well so the profile editor cannot
 * be used to set a name that sign-up would have refused.
 */
const NAME_PATTERN = /^[A-Zក-៿][A-Za-zក-៿]*$/;

const NAME_MESSAGE =
  'Name must start with a capital letter and contain no spaces, ' +
  'digits or symbols';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(NAME_PATTERN, { message: NAME_MESSAGE })
  first_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(NAME_PATTERN, { message: NAME_MESSAGE })
  last_name?: string;

  @IsOptional()
  @IsUUID()
  major_id?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  year_level?: number;

  /**
   * `require_tld: false`, which is the whole reason avatar uploads worked in
   * production and failed locally.
   *
   * The URL comes from our own storage service — `${S3_PUBLIC_URL}/user-avatar/…`
   * — and in development that is `http://localhost:9000`. validator.isURL
   * demands a top-level domain by default, so `localhost` is refused and the
   * upload succeeded while the save that recorded it did not: the file landed
   * in MinIO and the row never learned about it.
   *
   * Still a URL check, not a free string. Note it does NOT constrain the host
   * to our own storage — that was already true before this change — so a
   * client can set any valid URL here and it will be rendered as an <img src>.
   * Tightening that means comparing against S3_PUBLIC_URL, which is a
   * deployment value and would invalidate stored avatars if it ever changed.
   */
  @IsOptional()
  @IsUrl({ require_tld: false })
  avatar_url?: string;

  /**
   * Telegram handle or t.me link. The empty string is allowed so the field can
   * be cleared — IsOptional only skips `undefined`.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(
    /^$|^@?[A-Za-z0-9_]{4,32}$|^(https?:\/\/)?t\.me\/[A-Za-z0-9_]{4,32}$/,
    {
      message: 'Enter a Telegram username like @student or a t.me link',
    },
  )
  telegram?: string;

  /**
   * The whole saved set, replacing what is stored. No empty string here — an
   * account is removed by leaving it out of the list, not by blanking it.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5, { message: 'You can save up to 5 Telegram accounts' })
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  @Matches(/^@?[A-Za-z0-9_]{4,32}$|^(https?:\/\/)?t\.me\/[A-Za-z0-9_]{4,32}$/, {
    each: true,
    message: 'Enter a Telegram username like @student or a t.me link',
  })
  telegram_handles?: string[];
}
