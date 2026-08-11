import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity';

/**
 * A file already in MinIO that no upload owns yet.
 *
 * The upload form sends each file the moment it's picked, so the transfer runs
 * while the user is still filling in the metadata. POST /documents then claims
 * these by id and turns them into `documents` rows.
 */
@Entity('staged_files')
export class StagedFile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  uploader_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'uploader_id' })
  uploader: User;

  @Column('text')
  file_url: string;

  // Bucket-relative object keys, kept so the objects can be removed when a
  // staged file is discarded or swept.
  @Column('text')
  storage_key: string;

  @Column({ type: 'text', nullable: true })
  preview_url: string | null;

  @Column({ type: 'text', nullable: true })
  preview_key: string | null;

  @Column({ type: 'text', nullable: true })
  original_name: string | null;

  @Column({ type: 'int', nullable: true })
  file_size_kb: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
