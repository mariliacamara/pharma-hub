# Open questions

What is undecided or unverified as of 2026-10-08. Remove an item when it is settled, and
record the outcome in `decisions/` if it was a decision.

## Needs a decision

| Question | Why it matters |
|---|---|
| Job queue: backed by PostgreSQL or by Redis? | Not decided. At about 185 jobs a day per store a PostgreSQL-backed queue is enough and avoids running Redis |
| Compare with or without shipping by default? | The report compares product prices and also stores totals with shipping. The client asked for prices; confirm |
| "Easy adjust" threshold | Default is 10 cents, from the client's own example. Confirm it per store |
| How do migrations run on deploy? | Proposed: a Railway pre-deploy command, `npx prisma migrate deploy`, with `DATABASE_MIGRATION_URL` available to that command. The image already carries the migrations. Not set up, since nothing is deployed |
| At what time does the daily collection run? | It should be after KuantoKusta re-imports the store's catalogue; one offer showed 00:49. Not set yet |

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
| `docker-compose.yml` and `Dockerfile` | Written but not run: the build environment had no running Docker. The same steps were verified by hand: a PostgreSQL 16 started directly, and the Dockerfile's commands run in order in an empty folder, ending with the service starting from the pruned output |
| Advisories in the Prisma command line's dependencies | `npm audit` reports high-severity advisories in `mysql2` and `deepmerge-ts`, which come with `prisma` 7.10.0, the newest 7.x release. The service does not use MySQL, and the only fix npm offers is a downgrade to Prisma 6. Whether they matter here was not analysed further; check again when Prisma publishes a newer release |
| Type-aware lint rules | The base uses the `recommended` rules of `typescript-eslint`, which do not use type information. A forgotten `await` (`no-floating-promises`) is therefore not reported. Enabling the type-checked rule set is a small change, not made yet |
| The page parser against a saved real page | The parser is tested with pages built to the observed structure. No real page was kept as a fixture |
| The Seller API sandbox | Not tested |
| Whether the Railway plan offers a fixed outbound IP | Not checked. It matters if KuantoKusta agrees to allow a specific IP |
| Whether one store can have two offers for the same KuantoKusta product | The schema forbids it, based on 347 offers with 347 distinct pages |

## Deferred

Out of scope for version 1 (decision 0013). Listed so they are not forgotten.

| Item | To settle when it is taken up |
|---|---|
| 4DPharma integration | What it syncs (stock, prices, orders) and for which stores |
| Farmácia Nova Porto as a second store | Whether it sells on KuantoKusta and under what store name |
