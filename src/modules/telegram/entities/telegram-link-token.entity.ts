import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * A one-shot proof that whoever starts the bot is the signed-in user.
 *
 * Only the SHA-256 of the token is kept. The raw value exists in the deep link
 * and in the user's Telegram message, and nowhere else — so a dump of this
 * table cannot be replayed into anyone's account.
 */
@Entity('telegram_link_tokens')
export class TelegramLinkToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  user_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'text', unique: true })
  token_hash: string;

  @Column({ type: 'timestamptz' })
  expires_at: Date;

  /** Set the moment it is redeemed; a second /start with it is refused. */
  @Column({ type: 'timestamptz', nullable: true })
  used_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
