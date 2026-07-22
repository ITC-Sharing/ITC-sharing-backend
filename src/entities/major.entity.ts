import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('majors')
export class Major {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('text')
  name: string;

  @Column('text')
  acronym: string;

  @Column({ type: 'text', nullable: true })
  image_url: string | null;
}
