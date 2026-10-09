# 0024. A collection survives being interrupted

- Status: Accepted
- Date: 2026-10-08

## Context

A collection takes from minutes to an hour. In that time the service can be redeployed,
restarted by the host, or lose the database for a moment. Starting over each time would
read the same pages twice, which is exactly what the website should not see.

## Decision

- **Each page reading is stored as soon as it is made** (`kk_page_snapshots`), not at the
  end. A reading newer than two hours is used instead of reading the page again, whether
  it came from the same collection before an interruption, from an earlier collection,
  or from another store that sells the same product.
- **Stopping politely.** When the service is asked to stop, the worker cuts its pause
  short, puts its collection back in the queue and only then lets the service close. The
  database connection is closed in the last phase of the shutdown, after that. Being
  asked to stop does not count against the collection.
- **Signs of life.** While it works, the worker writes the time into the row every half
  minute and after each page. A collection marked as running with no sign of life for
  three minutes is taken to be abandoned and goes back to the queue.
- **Three attempts.** A collection abandoned three times is recorded as failed
  (`abandoned`) and not tried again.
- **Crashes.** When something unexpected goes wrong, the collection is left as it is and
  taken up again as an abandoned one, a few minutes later. Most such causes pass by
  themselves. Only the third attempt records the failure (`internal_error`).
- **A worker that comes back.** Each time a collection is taken up, it gets a number.
  Everything a worker writes about it (sign of life, progress, result) applies only
  while that number is still the current one. A worker that was given up for dead and
  wakes later finds its writes ignored and stops.
- **A limit on the whole.** A collection still reading pages after six hours is stopped
  (`run_too_long`).

## Consequences

- A redeploy in the middle of a collection costs a few seconds, not a restart.
- After a crash or a kill the collection resumes by itself within about three minutes.
- No page is read twice within two hours, across interruptions and across stores.
- The comparison of a resumed collection can mix readings up to two hours apart.
- A collection that keeps crashing takes about ten minutes to be recorded as failed.
- Copying the store's offers at the start of a collection does not look at the stop
  signal. If the service is stopped during it and killed before it ends, the collection
  is found abandoned and resumed; one attempt is used.

## Alternatives rejected

- Write everything at the end, in one transaction: an interruption loses every page read.
- Trust the worker's memory for "am I still the one": two copies of the service can
  both believe it.
- Fail at the first crash: one second without the database would cost a store its day.
