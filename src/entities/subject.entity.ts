import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Major } from './major.entity';
import { User } from './user.entity';

@Entity('subjects')
export class Subject {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  major_id: string;

  @ManyToOne(() => Major)
  @JoinColumn({ name: 'major_id' })
  major: Major;

  @Column('text')
  name: string;

  // Short display code (initials of `name`), shown when a subject has no cover.
  @Column('text')
  acronym: string;

  @Column('int')
  year_level: number;

  @Column({ type: 'int', nullable: true })
  semester: number | null;

  @Column({ type: 'text', nullable: true })
  subject_url: string | null;

  @Column({ type: 'text', default: 'pending' })
  status: string;

  @Column({ type: 'uuid', nullable: true })
  submitted_by: string | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'submitted_by' })
  submitter: User | null;

  @Column({ type: 'text', nullable: true })
  rejection_reason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  rejected_at: Date | null;

  /** Who approved or rejected it; null until reviewed. */
  @Column({ type: 'uuid', nullable: true })
  reviewed_by: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
