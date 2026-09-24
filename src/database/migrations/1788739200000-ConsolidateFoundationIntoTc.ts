import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Collapses the two rows for the foundation year into one, keyed TC.
 *
 * `TC` (Tronc Commun) is the current acronym; earlier data seeded the same
 * department a second time as `FOUNDATION`, leaving two rows with the identical
 * name. Only the literal 'foundation' was recognised as the foundation
 * programme, so anyone in TC was offered years 3–5 and never prompted to choose
 * a department at the end of year 2.
 *
 * Written to handle either shape a database may be in:
 *  - only FOUNDATION exists -> rename it, which preserves every reference;
 *  - both exist             -> repoint FOUNDATION's rows at TC, then drop it.
 */
export class ConsolidateFoundationIntoTc1788739200000 implements MigrationInterface {
  name = 'ConsolidateFoundationIntoTc1788739200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      do $$
      declare
        tc_id uuid;
        foundation_id uuid;
      begin
        select id into tc_id from majors where lower(acronym) = 'tc';
        select id into foundation_id from majors where lower(acronym) = 'foundation';

        if foundation_id is null then
          return;
        end if;

        if tc_id is null then
          -- Nothing to merge: the rename carries every reference with it.
          update majors set acronym = 'TC' where id = foundation_id;
          return;
        end if;

        -- Both rows exist. Move anything pointing at FOUNDATION over to TC
        -- before it goes, so no upload, subject or student is orphaned.
        update uploads  set major_id = tc_id where major_id = foundation_id;
        update subjects set major_id = tc_id where major_id = foundation_id;
        update users    set major_id = tc_id where major_id = foundation_id;

        -- Audience entries name the department by id too, and they are jsonb
        -- rather than a foreign key, so they need rewriting by hand.
        update uploads
           set audience = (
             select jsonb_agg(
               case when entry->>'major_id' = foundation_id::text
                    then jsonb_set(entry, '{major_id}', to_jsonb(tc_id::text))
                    else entry
               end
             )
             from jsonb_array_elements(audience) as entry
           )
         where audience @> jsonb_build_array(
                 jsonb_build_object('major_id', foundation_id::text)
               );

        delete from majors where id = foundation_id;
      end $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The merge is not reversible — once FOUNDATION's rows point at TC there is
    // no record of which ones were moved. Restoring the acronym is the most
    // that can be done, and only when TC is unused by any other data.
    await queryRunner.query(`
      update majors set acronym = 'FOUNDATION'
       where lower(acronym) = 'tc' and name = 'Department of Foundation Year';
    `);
  }
}
