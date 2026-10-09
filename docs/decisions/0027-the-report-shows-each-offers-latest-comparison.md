# 0027. The report shows each offer's latest comparison, marked stale when it predates the latest collection

- Status: Accepted
- Date: 2026-10-09

## Context

Every collection writes one row per offer it reached in `kk_price_comparisons`. A
collection does not always reach every offer: one that is blocked by the website, cut
short or that fails halfway still compares the pages it had read (`kuantokusta.md`,
"How a collection ends"). "The latest report" can therefore mean two different things:

- the rows of the latest collection, or
- the latest row of each offer, whichever collection wrote it.

They differ exactly when the latest collection did not reach every offer. With the
first, a collection blocked at page 40 of 185 would make the report shrink to 40
products, as if the other 145 had disappeared.

## Decision

`GET /v1/plugin/kuantokusta/report` returns, for each offer, its most recent comparison
(`ORDER BY compared_at DESC, id DESC LIMIT 1`, served by the existing index
`kk_price_comparisons_offer_compared_idx`).

- Each row carries the collection that wrote it (`runId`) and when (`comparedAt`).
- A row is `stale` when it was written by another collection than the most recent one
  that ended, and before that one ended. The answer also carries that collection
  (`run`), with its status and error code, so the plugin can say "the last collection
  was blocked; 145 prices are from the day before".
- The summary counts `stale` rows, so the plugin can warn without reading every page.
- Offers that were never compared are not listed.

## Consequences

- The report never loses rows because of a bad collection, and never pretends an old
  price is new: the date and the flag are on each row.
- A collection that fails before reading any page (no key, Seller API away) makes every
  row stale. That is true: none of them is from the last attempt.
- Comparisons are written when a collection ends, so a collection still running never
  makes rows stale.

## Alternatives rejected

- Only the rows of the latest collection: the report would shrink after every partial
  or blocked collection.
- Only the rows of the latest collection that succeeded: a long string of partial
  collections would leave the report days old, and the offers they did read would be
  hidden.
