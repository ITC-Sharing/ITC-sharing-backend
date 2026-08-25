<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

The backend runs on **self-hosted Postgres** (via TypeORM) with **S3-compatible object
storage** (MinIO locally). Both are provided by `docker-compose.yml`.

```bash
# 1. Install dependencies
$ npm install

# 2. Start Postgres + MinIO (buckets are created and made public automatically)
$ docker compose up -d

# 3. Copy env template and adjust if needed
$ cp .env.example .env
```

Services:
- Postgres → `localhost:5432` (db `itc_sharing`, user `itc`)
- MinIO API → `localhost:9000` · MinIO console → `localhost:9001` (`minioadmin` / `minioadmin`)

Configuration lives in `.env`:
- `DATABASE_URL` — Postgres connection string
- `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_PUBLIC_URL` — object storage

## Database schema

The schema is owned by **TypeORM migrations** in
[`src/database/migrations`](src/database/migrations) — one per table, ordered by
foreign-key dependency, each carrying its own indexes. TypeORM runs with
`synchronize: false` and must never alter the schema on its own.

Pending migrations are applied **at boot** (`migrationsRun` in
[`src/config/database.config.ts`](src/config/database.config.ts)), so
`docker compose up` is enough to stand up a brand-new database — there is no
separate migrate step. They are also available directly:

```bash
$ npm run migration:show      # what is applied, what is pending
$ npm run migration:run       # apply pending
$ npm run migration:revert    # undo the most recent one
```

To change the schema, add a migration — never edit an applied one:

```bash
$ npm run migration:create -- src/database/migrations/DescribeTheChange
```

`src/database/data-source.ts` exists only for that CLI; the running app builds
its options from `ConfigService` instead.

## First run — seed the database

Migrations create the schema but no data, and `majors` starts empty. That is a
deadlock on a brand-new database: registration requires a `major_id`, and
`POST /majors` is admin-only — so with zero majors nobody can sign up, and with
no users there is no admin to add one.

The seeders break it. Run once, after the migrations:

```bash
$ npm run seed
```

That inserts all 13 ITC departments, uploads their logos, and creates one admin
account. With no
`SEED_ADMIN_*` variables set it creates `admin@itc.edu.kh` and prints a
generated password **once** — save it, then change it after first login:

```
  majors:  +13 inserted, 0 already present (13 total)
  logos:   13 uploaded, 0 already had one
  admin:   created admin@itc.edu.kh
  ┌─────────────────────────────────────────────────────────
  │ Generated admin password — shown once, save it now:
  │   Xfg1ye45WpXr5ggGxy8Ijfc1
  └─────────────────────────────────────────────────────────
```

To choose the credentials instead, set them in `.env` (see `.env.example`):
`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_FIRST_NAME`,
`SEED_ADMIN_LAST_NAME`, `SEED_ADMIN_MAJOR`.

Seeding is **not** wired into application boot, unlike migrations — creating an
admin account on every container restart is not something a server should do.
Every seeder is idempotent, so re-running is safe: existing departments are
skipped, and an existing account is left alone (or promoted to admin if it was
not already).

In a compiled image there is no ts-node, so run the built file instead:

```bash
$ node dist/database/seeders/seed
```

Seed data lives in [`src/database/seeders`](src/database/seeders) — edit
`majors.seeder.ts` to change the department list.

Department logos are real image files in `seeders/assets`, named after the
lowercased acronym (`gic.png`). The seeder **uploads the bytes** and stores the
URL the upload returns, rather than seeding a hardcoded URL — `majors.image_url`
is absolute and built from `S3_PUBLIC_URL`, so a hardcoded one would point at
whichever machine it was written on and give every new deployment 13 broken
images. To add or replace one, drop a file in named for its acronym; a
department that already has a logo is never overwritten, so a logo changed
through the admin UI survives re-seeding.

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
