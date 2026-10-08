# 0011. NestJS, Prisma and PostgreSQL, hosted on Railway

- Status: Accepted
- Date: 2026-10-08

## Context

The design assumed the team's usual stack. The owner confirmed it and chose the host.

## Decision

Pharma Hub is built with NestJS, Prisma and PostgreSQL and runs on Railway.

## Consequences

- **The application must not connect as the database superuser.** PostgreSQL superusers
  and table owners bypass Row Level Security, so with the default credentials of a managed
  database the store isolation of decision 0004 would be silently off. Create a dedicated
  application role, grant it only what it needs, and verify the isolation with that role.
- CHECK constraints and the RLS policies do not fit in `schema.prisma`. They live in SQL
  migrations, which are the reference (decision 0015).
- The store must be set at the start of every transaction (`SET LOCAL
  app.current_store_id`). With Prisma this means running tenant queries inside a
  transaction, which `PrismaService.withStore` does. Covered by integration tests.
- The API and the workers run as separate Railway services from the same repository, so
  the separation of queues between modules (decision 0002) also holds at process level.
- The master key that encrypts credentials is a Railway variable of the service, never a
  value in the database or the repository.
- Page reads leave from Railway's network, not from the stores' servers.

## Alternatives rejected

- Reusing StockGrid's deployment: see decision 0007.
