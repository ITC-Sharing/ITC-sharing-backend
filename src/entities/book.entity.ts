import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Major } from './major.entity';
import { User } from './user.entity';
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

  @Column({ type: 'uuid' })
  major_id: string;

  @ManyToOne(() => Major)
  @JoinColumn({ name: 'major_id' })
  major: Major;

  @Column('text')
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'text', nullable: true })
  contact: string | null;

  @Column({ type: 'text', nullable: true })
  cover_image_url: string | null;

  @Column({ type: 'text', default: 'available' })
  status: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @OneToMany(() => BookRequest, (req) => req.book)
  requests: BookRequest[];
}
