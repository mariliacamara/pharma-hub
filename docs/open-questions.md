# Open questions

What is undecided or unverified as of 2026-10-08. Remove an item when it is settled, and
record the outcome in `decisions/` if it was a decision.

## Needs a decision

| Question | Why it matters |
|---|---|
| Compare with or without shipping by default? | The report compares product prices and also stores totals with shipping. The client asked for prices; confirm |
| "Easy adjust" threshold | Default is 10 cents, from the client's own example. Confirm it per store |
| At what time does the daily collection run? | It should be well after KuantoKusta re-imports the store's catalogue (one offer showed 00:49), because pages read during the import can miss an offer. The schedule exists and is off; the time is the variable `KK_COLLECTION_DAILY_AT` (decision 0026) |
| Should `kk:sync-offers` go through the queue too? | A collection copies the offers first, and collections never overlap. The operator command still copies directly, in its own process; two copies of the same store wait for each other in the database, so the result is right, but they share the key's rate limit |
| Delete old page readings automatically | `kk_page_snapshots` only grows. A query to trim it by hand is in `operations.md`; a job is not built |
| Tell someone when a collection fails or is blocked | Nothing does. It is visible in `kk:runs` and, later, in the plugin |
| Refresh of a single offer | Designed (decision 0006), not built |
| When there are several stores: one after the other, as now? | One worker carries out one collection at a time for the whole hub (decision 0023). A round takes the sum of all stores |
| Limit on requests per token and per address | None yet. Needed before the API is used by more than the plugin |
| Should a token issued from the command line default to every scope and no expiry? | It does, because that is what the plugin needs. The review suggested read-only and an expiry by default |
| A command that re-encrypts every stored key after a master key rotation | Not built. Until then an old master key has to be kept (`operations.md`) |

## Needs an answer from someone else

| Question | Ask | Why it matters |
|---|---|---|
| Is a daily automated read of product pages accepted for partner stores, and within what limits? | KuantoKusta account manager | The terms of use were not read, and one test run was already refused. This protects the seller accounts |
| Does the back office or API expose competitiveness data (lowest price, position)? | KuantoKusta account manager | If yes, the page collection may be unnecessary |
| Why do 29 active offers carry a SKU on KuantoKusta that differs from the WooCommerce SKU? | Whoever configured the store's catalogue feed | Decides whether the SKU can ever be the only linking key |
| May the base be used in a client project? | The author of `luas10c/boilerplate-nestjs-swc` | The base has no licence file and declares `UNLICENSED` (decision 0018). Ask the author to add a licence (MIT is usual for a boilerplate) or to confirm permission in writing |

## Unverified

| Item | State |
|---|---|
| What made one client identification get a 403 | A run with a different client name and a real contact email was refused; the earlier identification worked. The cause was not isolated |
| Stability of page reads over time | One full run of 185 pages passed on 2026-10-08 with no block. Whether that holds every day is unknown |
| Does KuantoKusta order offers by price or by price plus shipping? | Not checked. It decides which comparison matters to the client: on price the store led 39 of 185 offers, with shipping 3 of 183 |
| What `shipping.minimumPrice` means on a product page | Assumed to be the cheapest delivery option. It may be conditional or a pick-up price |
| Meaning of `isTopBox` and `importAuto` | Undocumented. Observed correlations are in `kuantokusta.md` |
| Time zone of the API's `updatedAt` | The value has no offset. It is read as Portugal time by decision 0012; this was not confirmed with KuantoKusta |
| Linking by store URL (`url_to_postid`) | Proposed as the third key; only name matching was tested |
| `docker-compose.yml` | Not run. The `Dockerfile` was built and run with Docker on 2026-10-08, including the migration and the operator commands inside the image, and it runs on Railway |
| `railway ssh`, for the operator commands | Described in Railway's documentation; not tried. The Console tab of the service was used on 2026-10-08 and works |
| Regenerating the database password on Railway | Not tried |
| Does the Seller API ever return a short page in the middle of a list, or cap `maxResultsPerPage` below 100? | Not known. The client takes the first short page for the last one |
| How the Seller API identifies the seller behind a key | The offers list does not say. Without it, a key cannot be tied to its store |
| Advisories in the Prisma command line's dependencies | `npm audit` reports high-severity advisories in `mysql2` and `deepmerge-ts`, which come with `prisma` 7.10.0, the newest 7.x release. The service does not use MySQL, and the only fix npm offers is a downgrade to Prisma 6. Whether they matter here was not analysed further; check again when Prisma publishes a newer release |
| Type-aware lint rules | The base uses the `recommended` rules of `typescript-eslint`, which do not use type information. A forgotten `await` (`no-floating-promises`) is therefore not reported. Enabling the type-checked rule set is a small change, not made yet |
| The page parser against a saved real page | The parser is tested with pages built to the observed structure. No real page was kept as a fixture |
| The Seller API sandbox | Not tested |
| The collection against the real website, from the service | Not run yet. It was tested against a fake website built to the observed structure. The first real run should be watched: `kk:collect`, then `kk:runs` and the log |
| Which name the hub should give itself to the website | The default is `PharmaHubPriceReport/1.0 (price report for partner stores)`. One name with a real email was refused in testing and the cause was not isolated. `KK_COLLECTOR_USER_AGENT` changes it without a new build |
| Zincomed's name and number on KuantoKusta pages | Not looked up. The first collection works them out (decision 0025); `kk:status` shows the result |
| How the website answers a product address with a wrong slug | The hub follows a redirect to the same product. Whether the site redirects or answers 404 was not checked |
| How long Railway waits between asking the service to stop and killing it | Not checked. The worker needs a few seconds to put its collection back; if it is killed first, the collection resumes by itself three minutes later |
| Whether the Railway plan offers a fixed outbound IP | Not checked. It matters if KuantoKusta agrees to allow a specific IP |
| Whether one store can have two offers for the same KuantoKusta product | The schema forbids it, based on 347 offers with 347 distinct pages |

## Deferred

Out of scope for version 1 (decision 0013). Listed so they are not forgotten.

| Item | To settle when it is taken up |
|---|---|
| 4DPharma integration | What it syncs (stock, prices, orders) and for which stores |
| Farmácia Nova Porto as a second store | Whether it sells on KuantoKusta and under what store name |
