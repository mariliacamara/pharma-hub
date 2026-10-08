# 0002. One service with a module per integration

- Status: Accepted. Scope narrowed by decision 0013: only the KuantoKusta module is built for now.
- Date: 2026-10-08

## Context

Two integrations are planned for two stores: KuantoKusta price comparison and 4DPharma.
Nothing is in production. Both integrations need the same things: per-store credentials,
scheduled jobs, retries, run history and authentication of the WordPress plugin.

The position changed three times during the design, each time on new information:
plugin only, then a KuantoKusta middleware, then separate services, then this.

## Decision

Build one service (named Pharma Hub in decision 0009) with a shared core and one module per
integration. Modules share code and database but have separate queues and workers.

## Consequences

- The core is built once and 4DPharma reuses it.
- One thing to deploy and monitor.
- A KuantoKusta parser fix redeploys the service that will also run 4DPharma. Jobs must
  therefore be safe to interrupt and resume.
- Module boundaries have to be kept by discipline: no module reads another's tables.

## Alternatives rejected

- Everything inside the WordPress plugin: rejected because the collection is fragile and
  needs fixes deployed in one place, the store server's IP should stay out of it, pages
  shared by both stores should be read once, and scheduling on shared hosting depends on
  site visits.
- Separate services per integration: would be right if a working 4DPharma middleware
  already existed and had to be preserved. It does not.
- Extending StockGrid: see 0007.
