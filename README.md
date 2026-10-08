# Pharma Hub

One backend service that connects pharmacy stores to external systems. Each integration
is a module; all modules share one core.

**Scope of version 1: one store (Zincomed) and one integration (KuantoKusta).**
Farmácia Nova Porto and the 4DPharma integration are deferred (decision 0013).

## Status (2026-10-08)

| Step | State |
|---|---|
| Foundation: database, isolation between stores, KuantoKusta rules | Built, deployed on Railway |
| 1. Plugin tokens, encrypted KuantoKusta key, copy of the store's offers | Built |
| 2. Scheduled daily collection of competitor prices | Not built |
| 3. Routes for the price report; the WordPress plugin | Not built |
| 4. Admin API with Google sign-in; the panel | Not built |

Built on [`luas10c/boilerplate-nestjs-swc`](https://github.com/luas10c/boilerplate-nestjs-swc)
at commit `593e139`, with the corrections listed in decision 0018.

## Modules

| Module | Purpose | Status |
|---|---|---|
| `stores` | The tenants | Create and list, from the command line |
| `api-tokens` | Tokens that identify a store's plugin | Built |
| `credentials` | Each store's keys for external systems, encrypted | Built |
| `audit` | Append-only record of sensitive actions | Built |
| `kuantokusta` | Compare each store's prices with the lowest price on KuantoKusta | Seller API client and offers copy built; price collection not yet |
| `health` | `/health/live` and `/health/ready` | Built |
| `fourdpharma` | Integration with 4DPharma | Deferred. Not designed |

## The API so far

Every route needs a plugin token (`Authorization: Bearer phk_...`), except the health
checks. The store is always the one the token belongs to; no route accepts a store id.

| Route | Scope | Does |
|---|---|---|
| `PUT /v1/plugin/kuantokusta/credential` | `credentials:write` | Checks the store's KuantoKusta key with KuantoKusta and stores it encrypted |
| `GET /v1/plugin/kuantokusta/credential` | `prices:read` | Says whether a key is configured and its last four characters. Never the key |
| `GET /v1/plugin/kuantokusta/offers` | `prices:read` | The store's own offers, as last copied from KuantoKusta, in pages |
| `GET /health/live`, `GET /health/ready` | none | For the host |

Errors always have the same shape:
`{"error":{"code":"kk_key_rejected","message":"..."},"requestId":"..."}`. Clients branch
on `code`; `requestId` finds the request in the log.

The full reference, generated from the code, is at `/docs` when the service runs
outside production.

## Documentation

| File | Content |
|---|---|
| `docs/architecture.md` | Components, request flows, tenant isolation, build order |
| `docs/security.md` | How secrets and access are protected, and the limits of that protection |
| `docs/kuantokusta.md` | Everything learned about KuantoKusta: API, pages, rules, data quirks |
| `docs/operations.md` | Deploying on Railway, the operator commands, what to do when something breaks |
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
is at `http://localhost:7000/docs`.

To try the routes you need a store and a token:

```bash
npm run build
npm run cli -- store:create --slug zincomed --name Zincomed --brand "ZincoGroup Hub"
npm run cli -- token:issue --store zincomed --label "local"
```

Without Docker, create the application role yourself before migrating:

```bash
psql "$ADMIN_DATABASE_URL" -v app_password='a-long-random-password' -f db/roles.sql
```

### Environment variables

| Variable | Required | What it is |
|---|---|---|
| `DATABASE_URL` | yes | Connection of `pharma_hub_app`, the role the service runs as |
| `DATABASE_MIGRATION_URL` | for migrations | Connection of the owner of the tables. Read only by the Prisma command line |
| `CREDENTIALS_MASTER_KEY` | yes | Encrypts the stores' credentials. `<version>:<base64 of 32 random bytes>` |
| `CREDENTIALS_PREVIOUS_KEYS` | no | Older master keys, comma-separated, only while rotating |
| `KK_SELLER_API_BASE_URL` | no | Defaults to the production Seller API. In production it must be an address of `kuantokusta.pt` |
| `PORT` | no | Defaults to 7000. Railway sets it |
| `NODE_ENV` | no | Defaults to `production`. Set `development` locally (`.env.example` does) |

The service refuses to start when one is missing or malformed, when `DATABASE_URL` is a
role that could bypass the isolation between stores (decision 0016), or when the
database session is not in UTC (decision 0021).

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Starts the service and restarts it when a file changes |
| `npm run build` | Generates the Prisma client and compiles to `dist/` |
| `npm start` | Runs the compiled service (`node dist/main.js`) |
| `npm run cli -- <command>` | Operator commands (`node dist/cli.js`); run it without a command for the list |
| `npm test` | Unit tests: no database, nothing outside this machine |
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

The service runs on Railway from the `Dockerfile`. The steps, the variables and what was
learned doing it the first time are in `docs/operations.md`.

## Code layout

```
src/
  main.ts            starts the HTTP server
  cli.ts             starts an operator command
  app.module.ts      lists the modules; closes every route by default
  infra/             plumbing that is not a topic
    config/          environment variables, validated at startup
    database/        Prisma client, store-scoped transactions, the startup guards
    http/            error shape, request id and access log
    ids/             UUID v7
  modules/           one folder per topic (decision 0019)
    <topic>/
      <topic>.module.ts
      controllers/   HTTP routes
      services/      what the module does; database access
      domain/        pure rules: no database, no network, no framework
  cli/               the operator commands
  generated/         Prisma client (generated, not committed)
tests/
  unit/              mirrors src/
  integration/       against a real PostgreSQL, and a fake KuantoKusta on 127.0.0.1
  support/           the fake KuantoKusta Seller API
  fixtures/          files used by tests
prisma/              schema.prisma (derived) and the SQL migrations (source of truth)
db/                  one-time SQL: the application role
docs/                architecture, security, operations, KuantoKusta notes, decisions
```

Imports inside the project use the `#/` alias for `src/` (`#/infra/config/env`).

Three rules hold the design together:

- Any query on a store's data goes through `PrismaService.withStore(storeId, work)`.
  Outside it, the protected tables return nothing.
- The store id comes from the verified token (`@CurrentPrincipal()`), never from the
  request.
- A route is closed unless marked `@Public()`, and must declare its scopes with
  `@RequireScopes(...)` (decision 0022).

## Conventions

- Code, identifiers, database and documentation are in English.
- Two names (decision 0014). The technical name is Pharma Hub: `pharma-hub` in repository,
  package and URL names, `pharma_hub` in database identifiers. What a client sees in the
  panel and the plugin is a per-store setting; for ZincoGroup it is "ZincoGroup Hub".
- A module never reads another module's tables. KuantoKusta tables are prefixed `kk_`;
  4DPharma tables will be prefixed `fdp_`.
- Invariants live in the database (constraints), not only in application code.
- Money is integer cents.
- Time is stored as `timestamptz` in a UTC session (decision 0021), and shown, scheduled
  and interpreted in Portugal time, `Europe/Lisbon` (decision 0012).
- Every decision gets a record in `docs/decisions/` in the same change that implements it.
- Stack: NestJS 12, Prisma 7 and PostgreSQL, hosted on Railway (decisions 0011, 0017
  and 0018).
