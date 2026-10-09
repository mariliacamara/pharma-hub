# Decision records

One file per decision, numbered in order. A record is never rewritten to hide a change of
mind: when a decision is replaced, add a new record and mark the old one "Superseded by NNNN".

Template:

```
# NNNN. Title, stated as the decision

- Status: Proposed | Accepted | Superseded by NNNN | Partly superseded by NNNN
- Date: YYYY-MM-DD

## Context        What forced a decision, with the facts known at the time.
## Decision       What was decided.
## Consequences   What follows, including the costs.
## Alternatives rejected   What else was considered and why not.
```

| No. | Decision |
|---|---|
| [0001](0001-seller-api-and-product-pages-not-site-search.md) | Link offers through the Seller API and read product pages; do not use the site search |
| [0002](0002-one-service-with-modules.md) | One service with a module per integration |
| [0003](0003-kuantokusta-key-only-in-the-hub.md) | The KuantoKusta key is stored only in the hub |
| [0004](0004-tenant-isolation-in-the-database.md) | The store comes from the token, and isolation is enforced by the database |
| [0005](0005-raw-snapshots-and-computed-comparisons.md) | Store raw page readings and computed comparisons separately, in cents |
| [0006](0006-asynchronous-collection-one-at-a-time.md) | Collection is asynchronous, scheduled daily, one full run per store at a time |
| [0007](0007-do-not-build-on-stockgrid.md) | Do not build on StockGrid |
| [0008](0008-admin-api-with-google-sign-in.md) | Admin API in the core from the start; people sign in with Google |
| [0009](0009-name-pharma-hub.md) | The service is named Pharma Hub |
| [0010](0010-panel-for-owner-and-clients.md) | The panel is used by the owner and by clients, each client limited to their store |
| [0011](0011-nestjs-prisma-postgresql-on-railway.md) | NestJS, Prisma and PostgreSQL, hosted on Railway (the separate worker service: see 0023) |
| [0012](0012-portugal-time.md) | Portugal time everywhere a person or a schedule sees a time |
| [0013](0013-version-1-zincomed-and-kuantokusta-only.md) | Version 1 covers Zincomed and KuantoKusta only |
| [0014](0014-technical-name-and-client-facing-name.md) | A neutral technical name, and a client-facing name per store |
| [0015](0015-sql-migrations-are-the-source-of-truth.md) | SQL migrations are the source of truth; schema.prisma is derived |
| [0016](0016-refuse-to-start-with-a-role-that-bypasses-rls.md) | The service refuses to start with a database role that bypasses Row Level Security |
| [0017](0017-toolchain-versions.md) | NestJS 12 defaults, Prisma pinned to 7, npm workaround (partly superseded by 0018) |
| [0018](0018-build-on-the-boilerplate-nestjs-swc.md) | Build on the `boilerplate-nestjs-swc` base, with six corrections |
| [0019](0019-modules-live-under-src-modules.md) | Each topic is a folder under `src/modules` |
| [0020](0020-operator-commands-until-the-admin-api.md) | Operator commands, until the admin API exists |
| [0021](0021-database-sessions-run-in-utc.md) | Every database session runs in UTC |
| [0022](0022-routes-are-closed-unless-marked-public.md) | Every route is closed unless it is marked public |
| [0023](0023-the-collection-queue-is-a-table-and-one-worker.md) | The collection queue is the `job_runs` table, with one worker inside the service |
| [0024](0024-a-collection-survives-being-interrupted.md) | A collection survives being interrupted |
| [0025](0025-the-store-is-recognised-by-its-own-prices.md) | The store is recognised on the pages by its own prices |
| [0026](0026-refusals-stop-everyone-and-the-schedule-is-off-by-default.md) | A refusal by the website stops every store, and the daily schedule is off until agreed |
