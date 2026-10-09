# KuantoKusta module

Everything learned about KuantoKusta on 2026-10-08, and the rules the module follows.
Numbers are from Zincomed on that date and will drift.

## Goal

For each product a store sells on KuantoKusta, show: the store's price, the lowest price
among the other stores and which store has it, and the difference in euros and in percent.
Small differences (about 10 cents) are highlighted, because the store may want to adjust
the price to become the cheapest.

Version 1 is a report. It does not change prices anywhere.

Coverage: only products the store lists on KuantoKusta. For Zincomed that was 347 offers
(185 with stock) out of 2,314 products in WooCommerce.

## Two data sources

| Source | Gives | Does not give |
|---|---|---|
| Seller API (official) | The store's own offers, each with the URL of its KuantoKusta product page | Competitor prices, position |
| Product page (public) | Every store's price for that product | Which WooCommerce product it is |

There is no official source for competitor prices. The site search cannot be used (see
robots.txt below), which is why the Seller API is what links a store product to its page.

## Seller API

- Spec: "KK Seller API" v1.2.0, Swagger UI at `https://seller.kuantokusta.pt/api/kms/`,
  OpenAPI JSON at `https://seller.kuantokusta.pt/api/kms-json`.
- Servers: production `https://seller.kuantokusta.pt/api`, sandbox
  `https://seller-sandbox.kuantokusta.pt/api` (the sandbox was not tested).
- Auth: header `x-api-key`, one key per store, obtained from the KuantoKusta back office.
- Rate limits per key: 5 requests per second, 20 per 10 seconds, 30 per 60 seconds.
  Exceeding one returns 429 (`KMS0429`) with `Retry-After` and blocks the key for 30 seconds.
- The module uses one endpoint: `GET /v2/kms/offers?page=N&maxResultsPerPage=100`.
  The response is a bare array with no total; read until a page comes back short.
- The API also has write endpoints (offer price and stock, order approve/send/cancel).
  Version 1 must not call them.
- A wrong key is answered with `401` and the body `{"error":{"code":"KMS0000"}}`
  (observed on 2026-10-08). The client treats a 401 or 403 as "key refused" only when the
  body has that format; any other 401 or 403 is a firewall or a proxy, not the API.

### How the client behaves

| Situation | What the client does |
|---|---|
| Normal | Reads page 1, 2, 3... of 100 until a page comes back short. Stays one below each published rate limit |
| `429` | Waits what `Retry-After` says (30 s if it says nothing, 60 s at most), up to 3 tries per page |
| `5xx`, timeout (15 s), dropped connection | Tries again after 0.5-1 s, then 1-2 s; gives up after 3 tries |
| `401` / `403` in the API's error format | Stops: the key was refused |
| A redirect | Refused. The key is never sent to another address |
| Not JSON, not a list, larger than 5 MB a page or 50 MB in all, the same page twice, more than 300 pages | Stops: the answer is not what this client understands |
| The whole list takes more than 15 minutes | Stops |

It never returns part of a list. A list that is not complete is not used at all, because
missing offers would look like offers the store removed.

### The real response differs from the spec

Observed in production; the spec lists neither `sku` nor `ean`, and describes no field.

| Field | Observed |
|---|---|
| `sellerProductId` | `null` in all 347 offers |
| `sku` | The store's identifier as registered on KuantoKusta. Filled in 302 of 347 |
| `ean` | Filled in 340 of 347 |
| `productId` | A string such as `p-9-30068`. Not the id in the page URL |
| `productUrl` | The KuantoKusta product page, e.g. `https://www.kuantokusta.pt/p/3456679/<slug>` |
| `url` | The product page on the store's own site |
| `price`, `oldPrice`, `stock` | Numbers; price in euros with decimals |
| `importAuto` | `true` on all 185 offers with stock, `false` on all 162 with stock 0. Meaning unconfirmed |
| `isTopBox` | `true` on 7 offers. Meaning unconfirmed (see below) |
| `updatedAt` | `"2026-10-08 00:49:45"`, no time zone; read as Portugal time (decision 0012). All offers had that day's date |
| also | `brandName`, `categoryName`, `productNameKK`, `image`, `cpc`, `commission`, `categoryId`, `isBlacklisted`, `shipping` |

### `isTopBox` is not "has the lowest price"

In a 20-page sample it agreed with "the store has the lowest price on the page" 18 times.
Counterexample: the API marked an offer as top box with the store at 59.04 EUR while
another store sold the same product at 52.99 EUR. The module computes the position from
the page and treats `isTopBox` as information only.

## Copying the store's offers into the hub

Built in step 1. First real copy on 2026-10-08, from the service on Railway with
Zincomed's key: 346 offers returned, 346 stored, none skipped, 45 without SKU and 7
without EAN. `modules/kuantokusta/domain/seller-offer.ts` reads each item;
`offers-sync.service.ts` writes the result.

### Reading an item

Third-party data, so every field is checked. An item that cannot be used is skipped and
counted by reason; the others are still stored.

| Reason | The item |
|---|---|
| `missing_offer_ref` | has no `productId` |
| `bad_product_url` | has a `productUrl` that is not exactly a KuantoKusta product page (`security.md`) |
| `missing_name` | has neither `productName` nor `productNameKK` |
| `bad_store_url` | has a `url` that is not an http(s) address |
| `bad_price` | has a price that is not a number between 0 and 1,000,000 |
| `bad_stock` | has a stock that is not a whole number of 0 or more |
| `duplicate_in_response` | repeats the reference or the product of an earlier item |
| `conflicting_identity` | matches two different stored offers at once (see below) |
| `not_an_object` | is not an object at all |

If items came back and none could be read, nothing is stored: the format changed.

Missing `sku`, `ean` or `updatedAt` are not errors. The result reports how many offers
have no SKU and no EAN; a sudden jump means a field changed type or name.

### Recognising an offer from one day to the next

A stored offer has two identities, both unique per store: the reference (`productId`)
and the product (the id in `productUrl`). KuantoKusta can change either: an offer moved
to the right product page keeps its reference, an offer created again keeps its product.
A match on one of them is enough; the row then takes the new value of the other. An item
that matches two different rows is left alone and reported.

### Offers that disappear

A listed offer that is missing from the answer is marked `delisted`. It is kept, with
its history, and becomes `listed` again if it comes back. Two safeguards:

- **Something was skipped:** nothing is delisted that time. The missing offer may be the
  one whose item could not be read.
- **Too many at once:** if more than 10 offers, and more than 20% of the listed ones,
  are missing, nothing is delisted. An empty or cut-short answer looks exactly like a
  catalogue that vanished. The next whole answer puts things right by itself; if the
  store really removed them, an operator confirms with `--allow-mass-delisting`.

Not verified: whether KuantoKusta ever returns a page with fewer than 100 items in the
middle of a list (the client would take it for the last page), and whether reading
pages while KuantoKusta re-imports the catalogue can make an offer fall between two
pages. The second safeguard covers the large cases; the daily collection should run
well after the import.

## Linking an offer to a WooCommerce product

The link cannot rely on the SKU alone. For Zincomed's 347 offers:

| Key, tried in this order | Offers linked |
|---|---|
| `sku` equals the WooCommerce SKU | 237 |
| `ean` equals the WooCommerce EAN | 77 |
| Product name identical | 33 |
| Not linked | 0 |

In the plugin the third key should be the store URL (`url`), resolved with
`url_to_postid`, which is more reliable than the name. That was not tested; the name match
was what the exported data allowed.

Known quirks:

- 29 offers with stock carry a `sku` on KuantoKusta that is not the product's current
  WooCommerce SKU (examples: manufacturer codes, or a different 7-digit code). Cause unknown.
- Two `sku` values appear on two offers each. In one case the KuantoKusta listing has the
  wrong SKU for the product.
- In WooCommerce, only 374 of 2,314 products have an EAN, while 2,302 have a unique SKU
  (a 7-digit code in 2,296 of them). The API returns EANs the store does not have, so it
  can be used to fill them in; when both sides have a different EAN, neither is
  automatically right.

The plugin stores the link once found instead of recomputing it every day.

## Product pages

### What robots.txt allows

For generic clients (`User-agent: *`), checked on 2026-10-08:

- Allowed: product pages, `/p/<id>/<slug>`.
- Disallowed, and relevant here: `/search*`, `/api/*`, `/precos*`, `/melhores-precos*`,
  `/marca/*`, `/product*`, any URL containing `price=`, `sort=` or `pag=`, and any URL
  ending in a hyphen (`/*-$`).
- No `Crawl-delay`.
- A long list of crawlers is banned by name. A rule for the `_pxhc` parameter indicates
  the site uses PerimeterX bot protection.

The site's terms of use were not read (the pages could not be fetched). Permission from
the KuantoKusta account manager for a daily read is still pending
(see `open-questions.md`).

### Where the data is

The page embeds a JSON document in `<script id="__NEXT_DATA__">`. The offers are at:

```
props.pageProps.basePage.product.offers[]
```

Fields used, per store: `storeName`, `storeSlug`, `sellerId`, `price`,
`shipping.minimumPrice`, `isHighlighted`, `filters.isMarketplace`. An entry with a price
above 1,000,000 EUR is left out, and a list of more than 1,000 entries is not accepted
as a product page. Also present:
`productId` (numeric, the id in the URL), `oldPrice`, `lastCheckedAt`, `rating`, `badges`,
`businessRules`.

All 20 sampled pages had this list, and also a JSON-LD block with the lowest price.

### Collection rules

1. Read `robots.txt` first and skip any URL it disallows. If the rules cannot be
   obtained, read nothing.
2. Use `productUrl` exactly as the API returned it. Add no parameters.
3. Read the HTML page only. Never call the site's `/api/` endpoints.
4. Identify the client honestly in the `User-Agent`. Do not imitate a browser.
5. One request at a time, about 5 seconds apart, with jitter.
6. Stop the run after 3 consecutive blocked responses, and mark it `blocked`. Never
   retry a refused page. After a block, no store's collection goes to the site for 30
   minutes.
7. If the offers path is missing, record `no_offer_list`. Never store an empty result as
   if it were real: a missing path means the site changed.
8. Read only offers with stock, about 185 pages a day for Zincomed (roughly 20 minutes).

These rules are enforced by the code described in "The collection" below, and each has a
test that fails when the rule is removed (decision 0026).

### What happened in testing

- 20 pages read with `TesteComparadorPrecos/0.1 (teste de viabilidade; seu@email)`:
  all returned 200, median response 717 ms.
- A run identifying as `ComparadorPrecosZincomed/0.1 (relatorio de precos; <a real email>)`
  got 403 on `robots.txt`. Repeating with the first identification worked. Which part of
  the string triggered the block was not isolated.

- A full run on 2026-10-08 read all 185 active offers with the first identification:
  185 pages returned data, none blocked, none without an offer list. On one page the store
  itself was not listed, although the Seller API reported stock.

The collection is fragile. Expect to adjust it, and keep the parser and the HTTP client in
one place.

## The collection

Built in step 2. Tested against a fake Seller API and a fake website on the test
machine. **Not yet run against the real website from the service**: the numbers under
"What happened in testing" come from the feasibility scripts of 2026-10-08.

Checked end to end on 2026-10-08 with the built service and both fakes: `kk:collect`
from a second process queued a collection of 7 pages; the service was stopped with
SIGTERM after 2 pages and put the collection back in the queue; started again, it read
the other 5, 4 to 6 seconds apart, recognised the store and stored 7 comparisons. No
page was requested twice, and asking again over HTTP answered 429 with `Retry-After`.

Code: `modules/kuantokusta/services/collection*.ts` and `product-page.client.ts`; the
pure rules in `domain/page-reading.ts`, `store-identity.ts` and `daily-schedule.ts`.

### What one collection does

1. Copies the store's offers from the Seller API (as above). If that fails, the
   collection fails and the website is not touched.
2. Takes the offers that are listed and in stock.
3. For each, uses a reading of its page made in the last two hours if there is one.
4. For the rest: reads `robots.txt`, then one page every five seconds, storing each
   reading as it is made.
5. Works out which store on the pages is the hub's (decision 0025).
6. Stores one comparison per offer. An offer whose page could not be read gets a
   `no_data` row with the store's own price.

A collection is asked for by the plugin (`POST /v1/plugin/kuantokusta/runs`), by an
operator (`kk:collect`) or by the daily schedule, and carried out by the one worker
inside the service (decision 0023). The plugin follows it with
`GET /v1/plugin/kuantokusta/runs/{id}`.

### What a page reading can be

| Outcome | Meaning | Used again within two hours? |
|---|---|---|
| `ok` | The page came and its list of offers was found (the list may be empty) | Yes |
| `not_found` | 404 or 410: the page no longer exists | Yes |
| `no_offer_list` | The page came, but the offers are not where expected | Yes |
| `blocked` | 403, 429, or a challenge page whatever its status | No |
| `http_error` | Any other status, or a redirect that is not to the same product | No |
| `network_error` | No answer, a timeout (20 s), or a page larger than 4 MB | No |

A reading is reused only if it was made by the current version of the parser
(`PARSER_VERSION`).

### How a collection ends

| Status | Meaning |
|---|---|
| `succeeded` | Every page was read |
| `partial` | Some pages could not be read; the others were compared |
| `blocked` | The website refused the hub. See the code |
| `failed` | See the code |

| Code | Status | Meaning | Website asked? |
|---|---|---|---|
| `kk_key_missing`, `kk_key_rejected`, `credential_unreadable` | failed | The store's key | No |
| `kk_rate_limited`, `kk_unavailable`, `kk_unexpected_response` | failed | The Seller API | No |
| `robots_refused` | blocked | `robots.txt` answered 401, 403, 429 or a challenge page, or disallows every product page | Only `robots.txt` |
| `robots_unavailable` | failed | `robots.txt` could not be obtained, or is not a robots.txt | Only `robots.txt` |
| `crawl_delay_too_long` | failed | `robots.txt` asks for more than 2 minutes between pages | Only `robots.txt` |
| `blocked_by_site` | blocked | Three pages refused in a row, now or in the last 30 minutes for any store | Yes, or not at all |
| `page_layout_changed` | failed | Ten pages in a row without the list of offers: the parser needs updating | Yes |
| `site_unavailable` | failed | Ten pages in a row failed | Yes |
| `no_page_read` | failed | Every page was tried and none could be used | Yes |
| `run_too_long` | failed | Still reading pages after six hours | Yes |
| `store_identity_unknown` | failed | The hub could not tell which store on the pages is its own. Set it with `kk:configure` | Yes |
| `abandoned` | failed | The worker vanished three times while carrying it out | Maybe |
| `internal_error` | failed | A bug, three times. The detail is in the log | Maybe |

In every case the pages that were read are kept, and compared if the store is known.

### Waiting before asking again

Asking while a collection is waiting or running returns that collection. After one ends,
a person has to wait: 15 minutes after a good one, an hour after a refusal or a failure
that came from the website, one minute after any other failure. The schedule and an
operator with `--ignore-wait` do not wait.

### Not built

- A refresh of a single offer.
- Deleting old readings. `kk_page_snapshots` grows by one row per page read
  (`operations.md` has the query to trim it by hand).
- Reading a page again when its address changed: the hub follows the redirect, but keeps
  the old address until the next copy of the offers brings the new one.

## First full result (Zincomed, 2026-10-08)

| | Offers |
|---|---|
| Analysed | 185 |
| Store is the cheapest | 39 |
| Tied for the lowest price | 1 |
| Store is more expensive | 144 |
| Store is the only one listed | 1 |

Among the 144: 4 within 0.10 EUR, 20 within 0.50 EUR, 31 within 1.00 EUR, 46 above
5.00 EUR; median gap 2.22 EUR.

Shipping changes the picture. The store charged 4.99 EUR on 176 of the 184 offers that
showed a shipping cost. Counting each store's minimum shipping, the store had the lowest
total on 3 of 183 offers, against 39 on price alone. The page's `shipping.minimumPrice`
may be a conditional or pick-up price, so this is an indication, not a verdict.

## Comparison rules

All arithmetic in integer cents.

- **Store's own offer:** matched by `sellerId` once it is known, otherwise by
  `storeSlug`; never by searching for the store name in the page text. The hub works
  out both by itself (decision 0025).
- **Store price:** the price on the page when the store is listed there, otherwise the
  Seller API price.
- **Lowest price:** the minimum among the *other* stores.
- **Difference** = store price - lowest price. Positive: the store is more expensive.
  Zero: tied. Negative: the store is the cheapest, by that margin.
- **Percentage** = difference / the higher of the two prices: how far the cheaper one is
  below the other. It keeps the sign of the difference and stays between -100% and 100%.
  (Dividing by the store price gave -160% for a product the store sold at 0.65 EUR against
  1.69 EUR, which reads as an error.)
- **Easy adjust:** the difference is positive and at most the store's threshold
  (default 10 cents). A tie is not an easy adjust: the store already has the lowest price.
- **Position:** 1 + the number of stores with a lower price.
- Prices are compared without shipping. The same comparison including the minimum
  shipping cost is stored alongside, because a store that is cheaper on the product can
  be dearer delivered.

Outcomes: `cheapest`, `tied`, `more_expensive`, `only_store`, `no_data`.

A "price to become cheapest" (lowest price minus one cent) can be shown, but the module
knows nothing about cost or margin. Whether to adjust is the store's decision.

Large differences deserve a manual look before acting. In the first full run, 4 of 185
offers sat on a KuantoKusta page for a different product or variant (a whitening
toothpaste for a "sensitive" one, a wrist monitor for an arm monitor, a wash gel for an
ointment, a "Protein" drink for an "Energy" one), and others showed gaps that suggest a
different pack size (a box of 10 at 27.89 EUR against 1.75 EUR). The report flags any
difference of 50% or more as `checkLink` (decision 0030), and the plugin should let a
user mark a link as wrong.

## The report

Built in step 3. `GET /v1/plugin/kuantokusta/report`, in `controllers/kk-report.controller.ts`
and `services/report.service.ts`.

- **One row per offer**, with its most recent comparison, whichever collection wrote it
  (decision 0027). Each row says which collection (`runId`) and when (`comparedAt`). A
  row older than the most recent collection that ended is `stale`: that collection did
  not reach the offer. The answer carries that collection (`run`), with its status and
  error code.
- **Only active offers by default** (listed and in stock, the ones a collection
  compares). `state=out_of_stock|delisted|all` shows the others with their last
  comparison; each row has `offerState` (decision 0028). Offers never compared are not
  listed.
- **Derived on read, never stored:** `differencePercent`, `easyAdjust` (with the store's
  threshold, returned as `easyAdjustCents`), `checkLink` (returned with
  `checkLinkPercent`) and `totalDifferenceCents`, the difference with shipping.
- **Filters:** `outcome`, `easyAdjust=true|false`, `checkLink=true|false`. The `summary`
  counts every offer of the chosen `state` by outcome, easy adjust, link check and
  stale, whatever the other filters.
- **Pages** of up to 200 rows, in the order of the offers, with `after` set to the
  previous `nextCursor`, like `GET /offers`. The plugin sorts.

Also:

- `GET /v1/plugin/kuantokusta/offers/{id}/history`: every comparison of one offer, newest
  first, in pages (`before` = the previous `nextCursor`).
- `GET` and `PUT /v1/plugin/kuantokusta/settings/easy-adjust`: the threshold in cents.
  Changing it needs `prices:refresh` (decision 0029) and is recorded in the audit log.
  Before it is ever changed, reading answers the default (10). It can be changed
  before the store's first collection.

## Timing

KuantoKusta shows a store's new price only after re-importing the store's catalogue. The
observed offers were all updated on the same day, one at 00:49 (Portugal time, by
decision 0012). So the daily collection should run after that import, and a manual refresh right after a price change will still
show the old price.
