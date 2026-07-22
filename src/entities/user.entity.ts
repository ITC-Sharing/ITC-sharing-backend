import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Major } from './major.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('text')
  first_name: string;

  @Column('text')
  last_name: string;

  @Column({ type: 'text', unique: true })
  email: string;

  @Column('text')
  password_hash: string;

  @Column({ type: 'text', default: 'user' })
  role: string;

  @Column({ type: 'uuid', nullable: true })
  major_id: string | null;

  @ManyToOne(() => Major, { nullable: true })
  @JoinColumn({ name: 'major_id' })
  major: Major | null;

  @Column({ type: 'int', nullable: true })
  year_level: number | null;

  @Column({ type: 'text', nullable: true })
  avatar_url: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
