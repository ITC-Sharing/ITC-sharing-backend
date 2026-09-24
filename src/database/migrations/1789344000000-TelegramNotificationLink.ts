import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Links a website account to a Telegram chat, so notifications can also be
 * delivered there.
 *
 * Separate from `users.telegram` / `users.telegram_handles`, which are contact
 * details a donor shows a receiver — a handle cannot be messaged by a bot and
 * can be retyped at will. Delivery needs the chat_id Telegram itself assigns,
 * which the user proves control of by starting the bot.
 *
 * `telegram_link_tokens` carries the proof. The token is generated for a
 * signed-in user, travels through the deep link, and comes back on /start; only
 * its SHA-256 hash is stored, so a leaked database row cannot be replayed into
 * someone's account.
 */
export class TelegramNotificationLink1789344000000 implements MigrationInterface {
  name = 'TelegramNotificationLink1789344000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table users
        add column if not exists telegram_chat_id text,
        add column if not exists telegram_linked_at timestamptz;
    `);

    /**
     * One chat, one account. Without this a single Telegram user could quietly
     * receive the notifications of several website accounts — and, worse, the
     * last /start would decide whose. Partial, because unlinked is the norm.
     */
    await queryRunner.query(`
      create unique index if not exists idx_users_telegram_chat
        on users (telegram_chat_id)
        where telegram_chat_id is not null;
    `);

    await queryRunner.query(`
      create table if not exists telegram_link_tokens (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users(id) on delete cascade,
        token_hash text not null unique,
        expires_at timestamptz not null,
        used_at timestamptz,
        created_at timestamptz not null default now()
      );
    `);

    await queryRunner.query(`
      create index if not exists idx_telegram_tokens_user
        on telegram_link_tokens (user_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists telegram_link_tokens;`);
    await queryRunner.query(`drop index if exists idx_users_telegram_chat;`);
    await queryRunner.query(`
      alter table users
        drop column if exists telegram_chat_id,
        drop column if exists telegram_linked_at;
    `);
  }
}
