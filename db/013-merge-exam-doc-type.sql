-- ============================================================================
-- ITC Sharing — 013: merge doc_type 'Examination paper' into 'Exam Preparation'
-- ----------------------------------------------------------------------------
-- Run against an existing database. Idempotent — safe to re-run.
--
-- The department list had 'Examination paper' and the language list added
-- 'Exam Preparation' for the same thing. One value now covers both, so existing
-- rows are moved over; the enum no longer accepts the old spelling.
-- ============================================================================

begin;

update uploads
   set doc_type = 'Exam Preparation'
 where doc_type = 'Examination paper';

commit;
