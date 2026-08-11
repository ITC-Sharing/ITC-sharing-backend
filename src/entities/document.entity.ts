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

  // PDF rendition for in-browser preview of office files (pptx/docx/xlsx),
  // generated on upload via LibreOffice. Null for files that don't need one
  // (already-previewable pdf/images) or when conversion was unavailable/failed.
  @Column({ type: 'text', nullable: true })
  preview_url: string | null;

  @Column({ type: 'text', nullable: true })
  original_name: string | null;

  @Column({ type: 'int', nullable: true })
  file_size_kb: number | null;
}
