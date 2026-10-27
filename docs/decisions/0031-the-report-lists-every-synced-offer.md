# 0031. The report lists every synced offer, compared or not

- Status: Accepted
- Date: 2026-10-27

## Context

Decision 0028 hid, by default, the offers a collection does not compare (out of stock or
off KuantoKusta), and decision 0027 left out the offers that were never compared. Together
they made the report show about half of the synced offers: 185 of about 346 in the first
full run, and 175 of 300 in the client's store.

The client wants to see every product synced from the store, whether it has stock or not
and whether it is active on KuantoKusta or not. Switching the plugin to `state=all` is not
enough: the report read each offer's latest comparison with a `CROSS JOIN LATERAL`, so an
offer that was out of stock or delisted in every collection (never compared) was not in
the result under any `state`.

## Decision

- The report reads the latest comparison with a `LEFT JOIN LATERAL`. Every offer of the
  store is a row, compared or not.
- An offer never compared is a row with `outcome` = `no_data`, `storePriceCents` = the
  offer's own price on KuantoKusta, and no comparison data. `runId` and `comparedAt` are
  null, `stale` is false, `easyAdjust` and `checkLink` are false.
- The summary counts those offers as `no_data`, and `outcome=no_data` returns them.
- The default `state` is `all`. `active`, `out_of_stock` and `delisted` still narrow the
  report, and `offerState` is still on every row (decision 0028 stays in force for them).
  `active` now includes an active offer that was never compared, such as one synced a
  moment ago.

## Consequences

- The report covers the same offers as `GET /offers?status=all`: the whole copy of the
  store's offers.
- `runId` and `comparedAt` can be null in the report. A consumer that read them as
  always present must handle null. The plugin is the only consumer.
- A `no_data` row can now mean "the page could not be read" or "never compared". The
  `runId` (null or not) tells them apart.
- Rows that are out of stock or delisted show an old comparison, or none. The row says
  how old (`comparedAt`, `stale`) and where the offer stands (`offerState`).

## Alternatives rejected

- Keep `active` as the default and let the plugin ask for `all`: the count in the summary
  and the list would still not match what the client sees as synced, unless the plugin
  always asks for `all`; the default then is dead weight.
- Compare the out-of-stock and delisted offers too: the pages of those offers do not
  show the store, so the comparison would be empty and cost requests for nothing.
- A separate route for the offers never compared: two lists to merge in the plugin, for
  the same table.
