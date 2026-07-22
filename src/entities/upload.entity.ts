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
import { Subject } from './subject.entity';
import { DocumentFile } from './document.entity';
import { DocumentTag } from './document-tag.entity';

@Entity('uploads')
export class Upload {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  uploader_id: string | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'uploader_id' })
  uploader: User | null;

  @Column({ type: 'uuid' })
  major_id: string;

  @ManyToOne(() => Major)
  @JoinColumn({ name: 'major_id' })
  major: Major;

  @Column({ type: 'uuid', nullable: true })
  subject_id: string | null;

  @ManyToOne(() => Subject, { nullable: true })
  @JoinColumn({ name: 'subject_id' })
  subject: Subject | null;

  @Column('text')
  title: string;

  @Column('text')
  doc_type: string;

  @Column('int')
  year_level: number;

  @Column({ type: 'text', nullable: true })
  academic_year: string | null;

  @Column({ type: 'text', default: 'pending' })
  status: string;

  @Column({ type: 'text', nullable: true })
  rejection_reason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  rejected_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  uploaded_at: Date;

  @OneToMany(() => DocumentFile, (doc) => doc.upload)
  documents: DocumentFile[];

  @OneToMany(() => DocumentTag, (tag) => tag.upload)
  tags: DocumentTag[];
}
