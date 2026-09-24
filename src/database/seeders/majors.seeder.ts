import { DataSource } from 'typeorm';

/**
 * The Institute's departments and faculties.
 *
 * `acronym` is the identity, not the name: department pages resolve by
 * lowercased acronym (the route slug) and the column is UNIQUE, so re-running
 * this updates nothing and inserts nothing already present.
 *
 * DFL is here for a reason worth remembering — no student registers *into* it,
 * but it owns course material everyone needs, so it must exist as a department
 * even though it will never appear as anyone's `users.major_id`. TC is
 * different: foundation students really are enrolled in it for years 1–2.
 */
export const MAJORS: { acronym: string; name: string }[] = [
  { acronym: 'AMS', name: 'Department of Applied Mathematics and Statistics' },
  { acronym: 'DFL', name: 'Department of Foreign Languages' },
  // TC (Tronc Commun) — the current acronym for the foundation year. Earlier
  // data called it FOUNDATION; ConsolidateFoundationIntoTc renames it.
  { acronym: 'TC', name: 'Department of Foundation Year' },
  { acronym: 'GAR', name: 'Department of Architectural Engineering' },
  { acronym: 'GCA', name: 'Faculty of Chemical and Food Engineering' },
  { acronym: 'GCI', name: 'Department of Civil Engineering' },
  { acronym: 'GEE', name: 'Department of Electrical and Energy Engineering' },
  {
    acronym: 'GGG',
    name: 'Faculty of Geo-resources and Geotechnical Engineering',
  },
  {
    acronym: 'GIC',
    name: 'Department of Information and Communication Engineering',
  },
  {
    acronym: 'GIM',
    name: 'Department of Industrial and Mechanical Engineering',
  },
  {
    acronym: 'GRU',
    name: 'Faculty of Hydrology and Water Resources Engineering',
  },
  {
    acronym: 'GTI',
    name: 'Department of Transport and Infrastructure Engineering',
  },
  {
    acronym: 'GTR',
    name: 'Department of Telecommunication and Network Engineering',
  },
];

export async function seedMajors(dataSource: DataSource): Promise<void> {
  const before = await count(dataSource);

  // One statement rather than a loop: ON CONFLICT makes the whole thing a no-op
  // for rows that already exist, so re-running is safe and cheap.
  await dataSource.query(
    `insert into majors (name, acronym)
     select * from unnest($1::text[], $2::text[])
     on conflict (acronym) do nothing`,
    [MAJORS.map((m) => m.name), MAJORS.map((m) => m.acronym)],
  );

  const after = await count(dataSource);
  console.log(
    `  majors:  +${after - before} inserted, ${MAJORS.length - (after - before)} already present (${after} total)`,
  );
}

async function count(dataSource: DataSource): Promise<number> {
  const [row] = await dataSource.query<{ n: string }[]>(
    'select count(*)::int as n from majors',
  );
  return Number(row.n);
}
