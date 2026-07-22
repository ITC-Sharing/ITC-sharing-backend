-- ============================================================================
-- ITC Sharing — 004: retention
-- ----------------------------------------------------------------------------
-- `refresh_tokens` and `notifications` are append-only in the application: no
-- code path ever deletes from them. Both grow without bound. Expired tokens in
-- particular are dead weight — they can never authenticate again.
--
-- This file defines the purge as a function, then wires it to a schedule.
-- Depends on the expires_at / created_at indexes from 003.
-- ============================================================================

begin;

-- ─── The purge ───────────────────────────────────────────────────────────────
-- Returns what it deleted so a scheduled run leaves a readable trace.
create or replace function purge_expired_data(
  notification_retention interval default '90 days'
)
returns table (refresh_tokens_deleted bigint, notifications_deleted bigint)
language plpgsql
as $$
declare
  tokens bigint;
  notes  bigint;
begin
  delete from refresh_tokens where expires_at < now();
  get diagnostics tokens = row_count;

  -- Read notifications are disposable once old. Unread ones are kept
  -- regardless of age — the user has not seen them yet.
  delete from notifications
   where is_read
     and created_at < now() - notification_retention;
  get diagnostics notes = row_count;

  return query select tokens, notes;
end $$;

commit;


-- ============================================================================
-- Scheduling — pick ONE of the two options below.
-- ============================================================================

-- ─── Option A: pg_cron (runs inside the database) ────────────────────────────
-- Self-hosted Postgres, so this is available — but the extension must be
-- preloaded first. In docker-compose.yml, add to the postgres service:
--
--   command:
--     - -c
--     - shared_preload_libraries=pg_cron
--     - -c
--     - cron.database_name=itc
--
-- (substitute the real POSTGRES_DB), restart the container, then uncomment:
--
-- create extension if not exists pg_cron;
--
-- select cron.schedule(
--   'purge-expired-data', '0 3 * * *',
--   $$ select purge_expired_data(); $$
-- );
--
-- Inspect runs with:  select * from cron.job_run_details order by start_time desc limit 10;


-- ─── Option B: host cron (no extension, no restart) ──────────────────────────
-- Simpler if you would rather not touch the Postgres startup config.
-- Add to the host crontab (`crontab -e`):
--
--   0 3 * * * docker compose -f /path/to/itc-sharing/docker-compose.yml \
--     exec -T postgres psql -U itc -d itc -c "select purge_expired_data();" \
--     >> /var/log/itc-purge.log 2>&1
--
-- Match -U and -d to POSTGRES_USER / POSTGRES_DB in docker-compose.yml.


-- ─── Note on a third option ──────────────────────────────────────────────────
-- A NestJS @Cron would keep the schedule in version control, which is nicer.
-- It needs `npm i @nestjs/schedule` plus ScheduleModule.forRoot() in
-- app.module.ts — not currently a dependency, so it is left out here rather
-- than added silently. The function above works unchanged if you switch later:
-- the job body is just `select purge_expired_data();`.
