import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Upload } from './upload.entity';

@Entity('document_tags')
export class DocumentTag {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  upload_id: string;

  @ManyToOne(() => Upload, (upload) => upload.tags, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'upload_id' })
  upload: Upload;

  @Column('text')
  tag: string;
}
