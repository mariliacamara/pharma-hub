# Pharma Hub

One backend service that connects pharmacy stores to external systems. Each integration
is a module; all modules share one core.

**Scope of version 1: one store (Zincomed) and one integration (KuantoKusta).**
Farmácia Nova Porto and the 4DPharma integration are deferred (decision 0013).

**Status (2026-10-08): foundation built.** The service starts, the database is created
from a migration, and the isolation between stores is proven by tests against a real
PostgreSQL. The KuantoKusta rules (reading a product page, comparing prices, obeying
robots.txt) are implemented and tested as pure functions.

Not built yet: the Seller API client, the scheduled collection, the routes for the
plugin, the admin API and the Google sign-in. Nothing is deployed.

Built on [`luas10c/boilerplate-nestjs-swc`](https://github.com/luas10c/boilerplate-nestjs-swc)
at commit `593e139`, with the corrections listed in decision 0018.

## Modules

| Module | Purpose | Status |
|---|---|---|
| Core | Stores, credentials, plugin tokens, job runs, admin access | Database and store isolation built; HTTP routes not yet |
| `kuantokusta` | Compare each store's prices with the lowest price on KuantoKusta | Page parser, comparison and robots rules built; collection not yet |
| `fourdpharma` | Integration with 4DPharma | Deferred. Not designed, nothing built for it |

## Clients of the service

| Client | What it is | Access |
|---|---|---|
| WordPress plugin (one install per store) | Shows the price report in the WooCommerce admin | Per-store token |
| Admin panel (may be built later) | Used by the owner and by clients. Shows reports and runs; the owner also manages stores, tokens and credentials | Sign in with Google |

## Documentation

| File | Content |
|---|---|
| `docs/architecture.md` | Components, request flows, tenant isolation, build order |
| `docs/security.md` | How secrets and access are protected, and the limits of that protection |
| `docs/kuantokusta.md` | Everything learned about KuantoKusta: API, pages, rules, data quirks |
| `docs/decisions/` | One short record per decision: what, why, what was rejected |
| `docs/open-questions.md` | What is undecided or unverified |
| `prisma/migrations/` | The database schema, as commented SQL. The source of truth |

## Running it locally

Requirements: Node.js 24, and PostgreSQL 14 or newer (the bundled `docker-compose.yml`
starts PostgreSQL 16).

```bash
cp .env.example .env          # local settings; never commit .env
docker compose up -d db       # PostgreSQL, with the application role already created
npm install
npm run db:migrate            # applies prisma/migrations with the privileged connection
npm run db:generate           # generates the Prisma client into src/generated
npm run dev
```

Check it: `curl localhost:7000/health/ready` answers `{"status":"ok"}`. The API reference
is at `http://localhost:7000/docs` (not served in production).

Without Docker, create the application role yourself before migrating:

```bash
psql "$ADMIN_DATABASE_URL" -v app_password='a-long-random-password' -f db/roles.sql
```

### Two database connections

| Variable | Role | Used by |
|---|---|---|
| `DATABASE_URL` | `pharma_hub_app` | The running service |
| `DATABASE_MIGRATION_URL` | The owner of the tables | The Prisma CLI only (migrations, introspection) |

The service refuses to start if `DATABASE_URL` is a superuser, has `BYPASSRLS`, or owns
the tables, because such a role ignores the isolation between stores without any error
(decision 0016).

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Starts the service and restarts it when a file changes |
| `npm run build` | Generates the Prisma client and compiles to `dist/` |
| `npm start` | Runs the compiled service (`node dist/main.js`) |
| `npm test` | Unit tests: no database, no network |
| `npm run test:int` | Integration tests: need the database above, migrated |
| `npm run test:coverage` | Unit tests with the coverage report |
| `npm run typecheck` | Checks types. The compiler (SWC) does not, so this is the only check |
| `npm run lint` | ESLint, which also enforces the code style |
| `npm run db:migrate` | Applies pending migrations |
| `npm run db:pull` | Refreshes `prisma/schema.prisma` from the database and regenerates the client |

Two git hooks run on every commit: one runs the lint and the type check, the other
rejects a message that does not follow
[Conventional Commits](https://www.conventionalcommits.org) (`feat: ...`, `fix: ...`,
`docs: ...`).

### Changing the database

The SQL migrations are the source of truth; `prisma/schema.prisma` is derived from the
database and never edited by hand (decision 0015).

1. Add a folder under `prisma/migrations/` with a `migration.sql`, written by hand.
2. `npm run db:migrate`
3. `npm run db:pull`, which refreshes `prisma/schema.prisma` and the generated client.
4. Commit the migration and the refreshed `schema.prisma` together.

## Deploying

Nothing is deployed yet; this is what the image expects.

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` (the Dockerfile sets it) |
| `PORT` | Set by the host |
| `DATABASE_URL` | Connection of `pharma_hub_app` |
| `DATABASE_MIGRATION_URL` | Connection of the owner of the tables. Needed only by the migration command |

Before each deploy, apply the migrations from the same image:
`npx prisma migrate deploy`. How this is wired on Railway is an open question
(`docs/open-questions.md`).

## Code layout

```
src/
  main.ts          starts the HTTP server
  app.module.ts    lists the modules
  infra/           technical plumbing, with no business rules
    config/        environment variables, validated at startup
    database/      Prisma client, store-scoped transactions, the role guard
  core/            what every integration shares
    health/        /health/live and /health/ready
  kuantokusta/     the KuantoKusta integration
    domain/        pure rules: page parser, price comparison, robots.txt, money
  generated/       Prisma client (generated, not committed)
tests/
  unit/            mirrors src/; no database, no network
  integration/     against a real PostgreSQL
  fixtures/        files used by tests
prisma/            schema.prisma (derived) and the SQL migrations (source of truth)
db/                one-time SQL: the application role
docs/              architecture, security, KuantoKusta notes, decisions, open questions
```

Imports inside the project use the `#/` alias for `src/` (`#/infra/config/env`).

Any query on a store's data goes through `PrismaService.withStore(storeId, work)`.
Outside it, the protected tables return nothing.

## Conventions

- Code, identifiers, database and documentation are in English.
- Two names (decision 0014). The technical name is Pharma Hub: `pharma-hub` in repository,
  package and URL names, `pharma_hub` in database identifiers. What a client sees in the
  panel and the plugin is a per-store setting; for ZincoGroup it is "ZincoGroup Hub".
- A module never reads another module's tables. The core is the only shared ground.
  KuantoKusta tables are prefixed `kk_`; 4DPharma tables will be prefixed `fdp_`.
- Invariants live in the database (constraints), not only in application code.
- Money is integer cents.
- Time is shown, scheduled and interpreted in Portugal time (`Europe/Lisbon`), and stored
  as `timestamptz` (decision 0012).
- Every decision gets a record in `docs/decisions/` in the same change that implements it.
- Stack: NestJS 12, Prisma 7 and PostgreSQL, hosted on Railway (decisions 0011, 0017
  and 0018).
