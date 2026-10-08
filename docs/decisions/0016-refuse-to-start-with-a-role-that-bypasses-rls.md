# 0016. The service refuses to start with a database role that bypasses Row Level Security

- Status: Accepted
- Date: 2026-10-08

## Context

Decision 0011 noted that PostgreSQL superusers, roles with BYPASSRLS and table owners
ignore Row Level Security without any error, and that a managed database hands out such
a role by default. A note in a document does not stop a wrong connection string.

## Decision

At startup the service inspects its own database role and exits with an explicit error
if the role is a superuser, has BYPASSRLS, or owns (or is a member of the owner of) any
protected table. Two connections exist: `DATABASE_URL` for the service, as
`pharma_hub_app`, and `DATABASE_MIGRATION_URL` for the Prisma CLI.

## Consequences

- A misconfigured deployment fails on boot instead of running with the isolation off.
- The application role has to be created once per database server (`db/roles.sql`)
  before the first migration; the migration fails loudly if it is missing.
- An integration test connects as the owner and asserts the refusal.

## Alternatives rejected

- Trust the deployment checklist: the failure would be silent and total.
- `FORCE ROW LEVEL SECURITY` on the tables: it covers the owner but not a superuser, and
  it would also subject migrations to the policies.
