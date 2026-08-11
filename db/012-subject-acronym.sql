-- ============================================================================
-- ITC Sharing — 012: subjects.slug → subjects.acronym
-- ----------------------------------------------------------------------------
-- Run against an existing database. Idempotent — safe to re-run.
--
-- The column always held a short display code: SubjectCard renders it in place
-- of a missing cover, uppercased and letter-spaced. Calling it a slug forced
-- lowercase kebab-case ("web-design") on something shown as "WD", so it is
-- renamed and its values re-derived as initials of the subject name. The API
-- derives it on create/rename; only admins can override it.
--
-- init.sql declares the column as `acronym` for a fresh database; the statements
-- below bring an existing database to the same shape.
-- ============================================================================

begin;

alter table subjects rename column slug to acronym;

-- Re-derive existing values: initials of each word, uppercased; single-word
-- names fall back to their first three characters. Mirrors acronymFromName().
update subjects
   set acronym = left(
     upper(
       case
         when array_length(regexp_split_to_array(btrim(name), '[^[:alnum:]]+'), 1) > 1
           then array_to_string(
             array(
               select left(w, 1)
                 from unnest(regexp_split_to_array(btrim(name), '[^[:alnum:]]+')) as w
                where w <> ''
             ), ''
           )
         else left(regexp_replace(btrim(name), '[^[:alnum:]]', '', 'g'), 3)
       end
     ), 10)
 where acronym is not null;

commit;
