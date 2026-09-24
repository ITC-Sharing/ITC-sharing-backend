import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Moves the pin off `uploads` and onto a per-user join table.
 *
 * AddUploadPinnedAt gave each upload one `pinned_at`, which only works while
 * pinning is the uploader's own privilege. Now that anyone may pin any document
 * they can see, a single column would be a shared slot: one reader's pin would
 * reorder the feed for everybody, and the next reader could unpin it.
 *
 * Existing pins are preserved by attributing them to the uploader, which is who
 * set them under the old rule.
 */
export class CreateUploadPins1788393600000 implements MigrationInterface {
  name = 'CreateUploadPins1788393600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table if not exists upload_pins (
        user_id   uuid not null references users (id)   on delete cascade,
        upload_id uuid not null references uploads (id) on delete cascade,
        pinned_at timestamptz not null default now(),
        primary key (user_id, upload_id)
      );

      -- Every listing left-joins this by viewer to sort their pins first.
      create index if not exists idx_upload_pins_user
        on upload_pins (user_id, pinned_at desc);

      insert into upload_pins (user_id, upload_id, pinned_at)
      select u.uploader_id, u.id, u.pinned_at
        from uploads u
       where u.pinned_at is not null and u.uploader_id is not null
      on conflict do nothing;

      drop index if exists idx_uploads_pinned;
      alter table uploads drop column if exists pinned_at;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table uploads add column if not exists pinned_at timestamptz;

      create index if not exists idx_uploads_pinned
        on uploads (uploader_id, pinned_at desc) where pinned_at is not null;

      -- Only the uploader's own pins fit back into the single column; pins by
      -- other readers have nowhere to go and are dropped with the table.
      update uploads u
         set pinned_at = p.pinned_at
        from upload_pins p
       where p.upload_id = u.id and p.user_id = u.uploader_id;

      drop table if exists upload_pins;
    `);
  }
}
