# 0021. Every database session runs in UTC

- Status: Accepted
- Date: 2026-10-08

## Context

The Prisma driver adapter for `pg` sends and reads `timestamptz` values as text without
an offset, and assumes that text is UTC. On a session whose time zone is not UTC:

- an instant written by the application is stored shifted by the session's offset;
- an instant read from the database arrives shifted the other way.

In a round trip the two errors cancel, so nothing looks wrong. They stop cancelling the
moment a time written by the application meets a time written by the database (`now()`).

Found on 2026-10-08, testing against a PostgreSQL whose default time zone was
America/Sao_Paulo: `"2026-10-08 00:49:45"` Lisbon time came back three hours early.
A managed database is usually in UTC, so production would not have shown it, until
someone changed a server or role default.

## Decision

- Every connection opened by the service sets `TimeZone=UTC`.
- At start-up the service checks the session time zone and refuses to start if it is not
  UTC (a connection string can override the setting).
- An integration test compares instants with what the database itself reports in UTC,
  not with a round trip.

## Consequences

- Decision 0012 (Portugal time) is unchanged: `Europe/Lisbon` is applied when showing,
  scheduling and reading third-party times that come without an offset. It is never the
  session's time zone.
- A connection pooler that rejects start-up parameters (PgBouncer in transaction mode,
  unless configured to ignore them) will not work with this setting. None is in use.
- SQL run by hand in another tool is not covered: `timestamptz` columns are still
  correct there, they are only displayed in that tool's zone.

## Alternatives rejected

- Rely on the server default being UTC: true today, by coincidence.
- `ALTER ROLE pharma_hub_app SET timezone = 'UTC'`: one more manual step per database,
  and nothing would notice if it were skipped.
