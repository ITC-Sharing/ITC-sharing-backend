import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Major } from '../../majors/entities/major.entity';
import { User } from '../../users/entities/user.entity';
import { BookRequest } from './book-request.entity';

@Entity('books')
export class Book {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  donor_id: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'donor_id' })
  donor: User;

  /** Null for a book that belongs to no department — see the migration. */
  @Column({ type: 'uuid', nullable: true })
  major_id: string | null;

  @ManyToOne(() => Major, { nullable: true })
  @JoinColumn({ name: 'major_id' })
  major: Major | null;

  @Column('text')
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'text', nullable: true })
  cover_image_url: string | null;

  /** available | reserved | donated — see the BookHandoverFlow migration. */
  @Column({ type: 'text', default: 'available' })
  status: string;

  /**
   * Set when an admin takes the listing out of circulation; null means visible.
   * Separate from `status` — a book can be available AND hidden, which is the
   * whole point of moderating one.
   */
  @Column({ type: 'timestamptz', nullable: true })
  hidden_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @OneToMany(() => BookRequest, (req) => req.book)
  requests: BookRequest[];
}
