import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** What a token authorises. One table, because the lifecycle is identical. */
export type EmailTokenPurpose = 'verify' | 'reset';

/**
 * A one-time secret sent to an address, to prove the person reading that inbox
 * is the person asking.
 *
 * `verify` proves a new account's address belongs to whoever registered.
 * `reset` authorises setting a new password without knowing the old one —
 * which makes it, for the minutes it is alive, as powerful as the password.
 * Both are therefore stored only as a SHA-256 hash, like refresh tokens: a
 * database leak must not hand over the accounts it describes.
 */
@Entity('email_tokens')
export class EmailToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @Column({ type: 'text' })
  purpose: EmailTokenPurpose;

  /**
   * What is compared against, and how it is stored depends on the purpose.
   *
   * `reset` holds the SHA-256 of a 32-byte random token — unguessable, so a
   * fast hash is fine and the lookup can be by hash.
   *
   * `verify` holds a BCRYPT hash of a 6-digit code. SHA-256 would be useless
   * there: a million preimages is a table an attacker builds in seconds, so a
   * database leak would hand over every live code. bcrypt makes that table
   * cost hours instead. The consequence is that a code cannot be looked up by
   * its hash, which is why verification is addressed by email and compared
   * afterwards.
   */
  @Column({ type: 'text', unique: true })
  token_hash: string;

  /**
   * Failed guesses against this token.
   *
   * Only meaningful for `verify`. A 6-digit code has a million possibilities;
   * without a cap that is minutes of scripted guessing, and the cap is what
   * makes the short secret safe rather than the secret itself.
   */
  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'timestamptz' })
  expires_at: Date;

  /**
   * When it was redeemed. Null means still live.
   *
   * The row is kept rather than deleted, for the same reason a rotated refresh
   * token is: a deleted row and a token that never existed are indistinguishable,
   * so a link clicked twice would report "invalid" when the honest answer is
   * "already used".
   */
  @Column({ type: 'timestamptz', nullable: true })
  consumed_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
