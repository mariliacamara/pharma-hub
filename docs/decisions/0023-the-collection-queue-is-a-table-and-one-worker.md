# 0023. The collection queue is the `job_runs` table, with one worker inside the service

- Status: Accepted
- Date: 2026-10-08

## Context

Decision 0006 says a collection is asynchronous and that a store has one at a time. It
left open what carries the work: a queue in PostgreSQL or in Redis, and a separate
worker service or not (decision 0011 expected a separate one).

The load is small: one collection per store per day, a few hundred pages each, one page
every five seconds. What matters is not speed. It is never reading the website faster
than promised, and never losing a collection without anyone noticing.

## Decision

- A collection is one row in `job_runs`. That row is the queue entry, the progress
  ("40 of 185") and the history. There is no second place to keep in step with it.
- There is no Redis.
- One worker, inside the HTTP service, carries out one collection at a time **for the
  whole hub**, oldest first. Every store's pages are on the same website, and the pause
  between pages is a promise to that website, not to each store.
- The worker is started from `main.ts` only. An operator command or a test never starts
  a second one.
- "One at a time" is decided in the database, not in the worker's memory: taking the
  next collection happens under a lock and looks at every store first. A second copy of
  the service (during a redeploy, for instance) cannot start a collection while another
  is running.
- The daily schedule is a clock in the same service that puts collections in the queue.
  It is off unless `KK_COLLECTION_DAILY_AT` is set (decision 0026).

## Consequences

- Nothing new to run, pay for or monitor.
- A collection for store B waits while store A's is running. With one store this does
  not matter. With many, the total time of a round is the sum of all of them; that is
  the price of the promise above, and the first thing to revisit.
- `job_runs` is protected per store (decision 0004), so the worker cannot ask for "every
  waiting collection" in one query: it visits each store in turn. Fine for a handful of
  stores.
- The worker shares the process with the API. A collection uses little (one request at a
  time), but a crash of one is a crash of both.
- The scheduled time is a variable, read at start. Changing it needs a redeploy.

## Alternatives rejected

- Redis with a queue library: a second service to run and secure, for one job a day.
- A separate worker service: the same code deployed twice, two sets of variables with
  the master key in both, for no benefit at this size. It can be split later without
  changing the table.
- One collection per store in parallel: it would multiply the rate of requests to the
  website by the number of stores.
