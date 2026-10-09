# 0030. Differences of 50% or more ask the user to check the link

- Status: Accepted
- Date: 2026-10-09

## Context

In the first full run, 4 of 185 offers sat on the KuantoKusta page of a different
product or variant, and others showed gaps that suggest a different pack size (a box of
10 at 27.89 EUR against 1.75 EUR). Those rows are not price gaps; acting on them would
be a mistake. `kuantokusta.md` asked the report to flag any difference of 50% or more.

## Decision

- Each row of the report has `checkLink`: true when the difference, measured like
  `differencePercent` (against the higher of the two prices), is 50% or more either
  way. 50% means one price is at most half the other.
- The limit is a constant (`CHECK_LINK_PERCENT` in `domain/comparison.ts`), returned in
  the report as `checkLinkPercent` so the plugin can show it. It is not a setting per
  store.
- Computed on read in whole numbers, by `needsLinkCheck` for the rows and by the same
  expression in SQL for the filter and the count, so both agree.
- The report can be filtered with `checkLink=true|false`, and the summary counts them.

## Consequences

- Changing the limit is a code change, and needs no recalculation.
- A real 50% gap is flagged too. The flag asks for a look; it does not hide the row.
- Marking a link as wrong belongs to the plugin, which owns the link to WooCommerce.

## Alternatives rejected

- A setting per store, next to the easy-adjust threshold: nobody asked to tune it yet.
- Measuring against the store's price: it passes 100% when the store is the cheaper
  one, and the same gap would be flagged one way and not the other.
