# 0028. Offers that left the stock or KuantoKusta are hidden from the report by default

- Status: Accepted
- Date: 2026-10-09

## Context

A collection compares only the offers that are listed on KuantoKusta and in stock
(`kuantokusta.md`, "What one collection does"). An offer that goes out of stock, or that
the Seller API stops returning (`delisted`), keeps its last comparison forever. With
decision 0027 that comparison would stay in the report, older every day, for a product
the store does not sell on KuantoKusta any more.

## Decision

- Each row of the report says where the offer stands today, from the latest copy of the
  store's offers: `offerState` is `active` (listed, stock above zero), `out_of_stock`
  (listed, stock zero) or `delisted`.
- By default the report shows `active` offers only. The query parameter `state`
  (`active`, `out_of_stock`, `delisted`, `all`) shows the others, with their last
  comparison.
- The summary is computed over the chosen `state`.

## Consequences

- The default report is the list of offers a collection actually compares, which is
  what the store can act on.
- An offer that comes back into stock appears again with its old comparison, marked
  `stale`, until the next collection compares it.
- The state comes from the copy of the offers, which every collection refreshes first,
  so it can be newer than the comparison next to it.

## Alternatives rejected

- Show them always, marked: dozens of old rows in the main table, mixed with the ones
  that matter.
- Delete or hide their comparisons for good: they are history, and the offer may come
  back.
