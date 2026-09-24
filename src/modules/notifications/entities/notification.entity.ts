import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @Column('text')
  type: string;

  @Column('text')
  message: string;

  @Column({ type: 'boolean', default: false })
  is_read: boolean;

  @Column({ type: 'uuid', nullable: true })
  ref_id: string | null;

  @Column({ type: 'text', nullable: true })
  ref_type: string | null;

  /**
   * Which phrase to show, and the values to put in it — see the client's
   * notification locale files. Null on rows written before translation
   * existed, where `message` is the only text there is.
   */
  @Column({ type: 'text', nullable: true })
  i18n_key: string | null;

  @Column({ type: 'jsonb', nullable: true })
  i18n_params: Record<string, string | number> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
