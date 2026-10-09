# 0006. Collection is asynchronous, scheduled daily, one full run per store at a time

- Status: Accepted
- Date: 2026-10-08

## Context

Reading about 185 pages at 5 seconds each takes roughly 20 minutes. Users also want a
button to regenerate the report. Every run is a burst of requests to a site that may
block the client.

## Decision

- The plugin never reads KuantoKusta during a page load; it shows the latest stored result.
- A daily schedule creates one run per store.
- "Regenerate" creates a run and returns immediately; the caller polls for progress.
- At most one full run per store may be queued or running. A unique partial index on
  `job_runs` enforces it.
- Manual runs have a minimum interval. A single-offer refresh is allowed in parallel.

How this was built is in decisions 0023 (the queue and the worker), 0024 (interruptions)
and 0026 (the daily schedule is off until KuantoKusta agrees; the waits after a run).
The single-offer refresh is not built.

## Consequences

- The report screen opens instantly and shows when the data was collected.
- Two clicks, or a click during the scheduled run, cannot double the load on the site.
- A refresh right after a price change still shows the old price until KuantoKusta
  re-imports the store's catalogue.

## Alternatives rejected

- Read pages on demand when the report opens: far too slow.
- Rely on application code for "one at a time": two simultaneous requests could both pass
  the check.
