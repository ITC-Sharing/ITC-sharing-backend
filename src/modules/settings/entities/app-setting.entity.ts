import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Operational values an admin changes from the dashboard, rather than a deploy.
 *
 * Key/value on purpose: these are one-off knobs, each read by exactly one
 * feature. Giving each its own column would mean a migration every time one is
 * added, to a table that will never have many rows.
 */
@Entity('app_settings')
export class AppSetting {
  @PrimaryColumn({ type: 'text' })
  key: string;

  /** Null means "not set" — distinct from a row that never existed. */
  @Column({ type: 'text', nullable: true })
  value: string | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @Column({ type: 'uuid', nullable: true })
  updated_by: string | null;
}
