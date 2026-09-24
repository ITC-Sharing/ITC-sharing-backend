import { IsISO8601, IsOptional, ValidateIf } from 'class-validator';

/**
 * When the next promotion rollover happens.
 *
 * `null` is a meaningful value — it clears the schedule — so the field is
 * validated as an ISO instant only when it is not null, rather than simply
 * being optional.
 */
export class SetPromotionDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsISO8601()
  rollover_at?: string | null;
}
