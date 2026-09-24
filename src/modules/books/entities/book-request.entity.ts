import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Book } from './book.entity';
import { User } from '../../users/entities/user.entity';

@Entity('book_requests')
export class BookRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  book_id: string;

  @ManyToOne(() => Book, (book) => book.requests, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'book_id' })
  book: Book;

  @Column({ type: 'uuid' })
  requester_id: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'requester_id' })
  requester: User;

  @Column({ type: 'text', nullable: true })
  message: string | null;

  @Column({ type: 'text', default: 'pending' })
  status: string;

  @CreateDateColumn({ type: 'timestamptz' })
  requested_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  resolved_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  accepted_at: Date | null;

  /** Set when the RECEIVER confirms the book physically changed hands. */
  @Column({ type: 'timestamptz', nullable: true })
  completed_at: Date | null;

  /** Either side called the reservation off before the handover. */
  @Column({ type: 'timestamptz', nullable: true })
  cancelled_at: Date | null;

  /** The reservation window ran out and the sweep released the book. */
  @Column({ type: 'timestamptz', nullable: true })
  expired_at: Date | null;

  @Column({ type: 'text', nullable: true })
  decline_reason: string | null;
}
