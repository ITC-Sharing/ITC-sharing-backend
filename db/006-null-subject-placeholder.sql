-- ============================================================================
-- ITC Sharing — 006: clear the subject cover placeholder
-- ----------------------------------------------------------------------------
-- Run against an existing database. Idempotent — safe to re-run.
--
-- subjects.create used to substitute a placeholder image when the submitter
-- uploaded nothing:
--
--   uploadedImageUrl ?? subjectUrl ?? this.defaultImageUrl
--
-- which stored `<S3_PUBLIC_URL>/subject-cover/no-image.png` in subject_url.
-- That made "no cover" indistinguishable from "a cover that happens to be the
-- placeholder", so the frontend had to sniff the filename to decide what to
-- render. The service now stores NULL instead; this brings existing rows into
-- line so the client can simply test for null.
--
-- Matched on the path rather than the full URL: S3_PUBLIC_URL differs between
-- environments (localhost:9000 locally, a real host in production), so hard
-- coding the origin would silently match nothing.
--
-- The no-image.png object itself is left in the bucket — harmless, and any
-- older client build still pointing at it keeps working.
-- ============================================================================

begin;

update subjects
   set subject_url = null
 where subject_url like '%/subject-cover/no-image.%';

commit;
