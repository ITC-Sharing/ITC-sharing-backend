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

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
