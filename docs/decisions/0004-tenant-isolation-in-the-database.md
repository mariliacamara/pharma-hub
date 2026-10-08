# 0004. The store comes from the token, and isolation is enforced by the database

- Status: Accepted
- Date: 2026-10-08

## Context

The hub serves several stores from one database. A bug that leaks one store's prices,
or lets one store's plugin use another's credentials, must not be possible through a
forgotten filter.

## Decision

- The store is derived from the authenticated token or session, never from a request
  parameter.
- Every table with store data has `store_id NOT NULL` and a Row Level Security policy tied
  to a per-transaction setting.
- Child rows reference their parents with composite foreign keys that include `store_id`.

## Consequences

- A query without a store filter returns nothing instead of another store's data.
- The application must set the store at the start of every transaction and must connect
  with a role that does not own the tables.
- CHECK constraints, the partial index and the policies do not fit in `schema.prisma`;
  they live in SQL migrations (decision 0015). Prisma with this setup is now covered by
  integration tests.

## Alternatives rejected

- Filtering by store only in application code: fails open when a filter is forgotten.
- One database per store: more to operate, and shared page readings would be duplicated.
