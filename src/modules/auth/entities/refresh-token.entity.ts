import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('refresh_tokens')
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @Column({ type: 'text', unique: true })
  token_hash: string;

  /**
   * The lineage this token belongs to: one family per sign-in, inherited by
   * every rotation. Reuse of any member revokes all of them — detecting a
   * replay is only worth anything if the descendants minted from the stolen
   * token can be named and revoked too.
   */
  @Column({ type: 'uuid' })
  family_id: string;

  /**
   * When this token was redeemed. Null means it is still live.
   *
   * A redeemed row is KEPT rather than deleted, until it expires. That is the
   * whole mechanism: a deleted row and a token that never existed look the
   * same, so without this a replayed credential is just another 401.
   */
  @Column({ type: 'timestamptz', nullable: true })
  consumed_at: Date | null;

  @Column({ type: 'timestamptz' })
  expires_at: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
