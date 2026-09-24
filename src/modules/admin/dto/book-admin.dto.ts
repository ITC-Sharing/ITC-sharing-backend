import { IsBoolean } from 'class-validator';

/**
 * Take a listing out of circulation, or put it back.
 *
 * Not a status change: `status` describes the donation (available vs donated)
 * and is the donor's business. Hiding is moderation, and the two are
 * independent — a book can be available and hidden at once.
 */
export class SetBookHiddenDto {
  @IsBoolean()
  hidden!: boolean;
}
