-- ============================================================================
-- ITC Sharing — 007: add documents.preview_url
-- ----------------------------------------------------------------------------
-- Run against an existing database. Idempotent — safe to re-run.
--
-- Office files (pptx/docx/xlsx) can't be rendered by browsers directly. On
-- upload the backend now converts them to PDF with LibreOffice and stores the
-- rendition's URL here; the frontend previews that PDF inline. Null for files
-- that need no rendition (pdf/images) or when conversion was unavailable.
--
-- init.sql declares this column inline for a fresh database; this statement
-- brings an existing database to the same shape.
-- ============================================================================

begin;

alter table documents
  add column if not exists preview_url text;

commit;
