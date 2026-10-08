# 0015. SQL migrations are the source of truth; schema.prisma is derived

- Status: Accepted
- Date: 2026-10-08

## Context

The schema relies on things Prisma's schema language cannot express: CHECK constraints
and Row Level Security policies. Letting Prisma generate migrations from `schema.prisma`
would silently leave those out, and they are exactly what protects the data.

## Decision

- Migrations are written by hand in SQL, under `prisma/migrations/`, and applied with
  `prisma migrate deploy`.
- `prisma/schema.prisma` is produced by `prisma db pull` from the migrated database and
  is never edited by hand. `prisma migrate dev` is not used.
- Privileges of the application role are granted in the migrations, table by table.

## Consequences

- Everything the database enforces is visible in one place, as commented SQL.
- A new table is inaccessible to the application until a migration grants it.
- Model and field names in code follow the database (`kk_store_offers`, `store_id`).
  They can be renamed later with `@@map`, which introspection preserves.
- Changing the database is a manual three-step routine, documented in the README.
- Prisma 7.10 does understand the partial unique index and writes it into
  `schema.prisma`. That makes `findUnique` available on a key that is only unique among
  active runs; do not use it there.

## Alternatives rejected

- Prisma-generated migrations with hand-edited SQL appended: the generated part and the
  hand-written part drift, and a regenerated migration can drop the hand-written part.
- No ORM, plain SQL everywhere: the owner chose Prisma (decision 0011).
