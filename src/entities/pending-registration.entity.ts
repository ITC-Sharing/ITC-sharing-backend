import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Major } from './major.entity';

/**
 * A registration part-way through OTP verification — see the
 * AddStudentIdAndPendingRegistrations migration.
 *
 * Deliberately NOT a half-built `users` row: an abandoned attempt should expire
 * quietly, and an unverified address must never be able to log in.
 */
@Entity('pending_registrations')
export class PendingRegistration {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('text')
  student_id: string;

  /** Derived from student_id server-side; never taken from the client. */
  @Column('text')
  email: string;

  @Column('text')
  first_name: string;

  @Column('text')
  last_name: string;

  @Column({ type: 'uuid' })
  major_id: string;

  @ManyToOne(() => Major)
  @JoinColumn({ name: 'major_id' })
  major: Major;

  @Column('int')
  year_level: number;

  /** bcrypt hash of the 6-digit code. */
  @Column('text')
  otp_hash: string;

  @Column({ type: 'timestamptz' })
  otp_expires_at: Date;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  /** Null until the code is accepted. Only a verified row may set a password. */
  @Column({ type: 'timestamptz', nullable: true })
  verified_at: Date | null;

  @Column({ type: 'timestamptz' })
  last_sent_at: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
