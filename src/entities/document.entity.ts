import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Upload } from './upload.entity';

// Named DocumentFile to avoid clashing with the DOM `Document` type.
@Entity('documents')
export class DocumentFile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  upload_id: string;

  @ManyToOne(() => Upload, (upload) => upload.documents, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'upload_id' })
  upload: Upload;

  @Column('text')
  file_url: string;

  @Column({ type: 'text', nullable: true })
  original_name: string | null;

  @Column({ type: 'int', nullable: true })
  file_size_kb: number | null;
}
