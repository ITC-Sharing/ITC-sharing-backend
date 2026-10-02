import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity';

/**
 * One row per ban, kept forever.
 *
 * The ban currently in force is ALSO on `users` (banned_at / ban_reason /
 * banned_by), and that pair is what every request checks — see the migration
 * for why the flag was not replaced by this table. Here the row survives the
 * unban, so "has this account been banned before?" has an answer.
 *
 * A row with `lifted_at` null is the ban in force; a partial unique index makes
 * two of them impossible.
 */
@Entity('user_bans')
@Index(['user_id', 'banned_at'])
export class UserBan {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  /** What the admin typed when banning; null when they gave no reason. */
  @Column({ type: 'text', nullable: true })
  reason: string | null;

  /**
   * Null once that admin's account is deleted — the ban still happened, so the
   * foreign key is `set null` rather than cascading the record away.
   */
  @Column({ type: 'uuid', nullable: true })
  banned_by: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'banned_by' })
  bannedBy: User | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  banned_at: Date;

  /** When the ban was lifted; null means it is the one in force. */
  @Column({ type: 'timestamptz', nullable: true })
  lifted_at: Date | null;

  @Column({ type: 'uuid', nullable: true })
  lifted_by: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'lifted_by' })
  liftedBy: User | null;
}
