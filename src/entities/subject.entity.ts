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

  @Column('text')
  slug: string;

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

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
