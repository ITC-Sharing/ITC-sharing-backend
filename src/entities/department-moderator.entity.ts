import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from './user.entity';
import { Major } from './major.entity';

/**
 * One person's authority to review submissions for one department.
 *
 * A table rather than a `users.role = 'moderator'` value: the role alone can't
 * say WHICH department, and one person may cover several. Admins are not listed
 * here — they can review everything, so a department without a moderator is
 * never stuck.
 */
@Entity('department_moderators')
export class DepartmentModerator {
  @PrimaryColumn({ type: 'uuid' })
  user_id: string;

  @PrimaryColumn({ type: 'uuid' })
  major_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Major, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'major_id' })
  major: Major;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
