# 0005. Store raw page readings and computed comparisons separately, in cents

- Status: Accepted
- Date: 2026-10-08

## Context

The report is derived data. The rules behind it will change: the threshold for an "easy
adjust", whether shipping counts, how the store's own offer is identified.

## Decision

Store two layers. `kk_page_snapshots` holds what each page showed (immutable, shared by
all stores, kept 90 days). `kk_price_comparisons` holds the result per store offer and
run (kept). Percentage and "easy adjust" are not stored; they are derived on read.
All money is integer cents.

## Consequences

- A rule change is a recalculation, not a new collection.
- One page reading serves every store that sells the product.
- History queries run on the small computed table.
- The offers inside a snapshot are JSON. That fits a third-party payload that is always
  read whole, but a question like "which competitor beats us most often" needs either the
  computed columns or a later normalisation.

## Alternatives rejected

- Store only the report: every rule change would need the site to be read again.
- Store the report as a file (CSV): no history, no per-store isolation.
