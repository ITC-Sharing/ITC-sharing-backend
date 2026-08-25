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

  /**
   * Review state for THIS file (see the CreateDocuments migration).
   *
   * 'active' for files that arrive with a new upload — the upload's own review
   * covers them. A file added to an already-approved upload lands 'pending' and
   * is hidden from everyone but its uploader until a moderator clears it, which
   * leaves the upload and its reviewed files untouched in the feed.
   */
  @Column({ type: 'text', default: 'active' })
  status: string;

  @Column({ type: 'text', nullable: true })
  rejection_reason: string | null;

  @Column({ type: 'uuid', nullable: true })
  reviewed_by: string | null;
}
