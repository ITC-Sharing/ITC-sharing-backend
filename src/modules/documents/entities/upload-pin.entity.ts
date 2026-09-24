import {
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Upload } from './upload.entity';

/**
 * One user pinning one upload to the top of their own listings.
 *
 * A join table rather than a column on `uploads`, because a pin belongs to the
 * reader, not to the document: anyone may pin any document they can see, and
 * that must not reorder the feed for anybody else. A column would give every
 * upload a single shared pin that the last person to click would own.
 *
 * The pair is the primary key, so pinning twice is idempotent, and both sides
 * cascade — deleting a user or an upload takes its pins with it.
 */
@Entity('upload_pins')
export class UploadPin {
  @PrimaryColumn({ type: 'uuid' })
  user_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @PrimaryColumn({ type: 'uuid' })
  upload_id: string;

  @ManyToOne(() => Upload, (u) => u.pins, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'upload_id' })
  upload: Upload;

  /** When it was pinned — several pins order among themselves, newest first. */
  @CreateDateColumn({ type: 'timestamptz' })
  pinned_at: Date;
}
