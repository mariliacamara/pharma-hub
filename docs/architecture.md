# Architecture

Status: the database, the store isolation and the KuantoKusta rules are built; the flows
below are designed and not built yet. Last updated 2026-10-08.

## Shape

One service, one database, one module per integration.

```
                  ┌───────────────────── Pharma Hub ─────────────────────┐
WordPress plugin ─┤  Core: stores, credentials, tokens, job runs, admin  │
(one per store)   │                                                      │
Admin panel ──────┤  ┌──────────────┐          ┌───────────────┐         │
(later)           │  │ kuantokusta  │          │  fourdpharma  │ (later) │
                  │  └──────┬───────┘          └───────┬───────┘         │
                  └─────────┼──────────────────────────┼─────────────────┘
                            ▼                          ▼
                 KuantoKusta Seller API           4DPharma API
                 + public product pages
```

Modules share code and database but **not queues or workers**. The KuantoKusta
collection is fragile (it reads a third-party site that can block it at any time), so a
stuck or blocked price collection must never delay the jobs of a future module.

## Responsibilities

| Part | Does | Does not |
|---|---|---|
| Hub | Holds credentials, calls external systems, stores history, computes results | Know anything about WooCommerce |
| Plugin | Shows the report, links each offer to a WooCommerce product, offers "regenerate" and CSV export | Call KuantoKusta, store the KuantoKusta key, compute comparisons |
| Admin panel | For the owner: creates stores, issues and revokes tokens, sets credentials. For owner and clients: shows reports and runs, triggers a refresh | Display any secret |

The panel and the plugin show the store's `brand_name` ("ZincoGroup Hub" for ZincoGroup),
never the technical name. Screens shown before the store is known, such as the login
page, use a neutral default.

The plugin never reads KuantoKusta while a page is loading. It shows the latest stored
result, so the screen opens immediately.

## Two kinds of access

| | Plugin | Admin |
|---|---|---|
| Principal | A machine: the store's WordPress | A person, in a browser |
| Authentication | Bearer token | Login with a server-side session |
| Reach | Its own store only | The stores the person is a member of |
| Routes | `/v1/plugin/...` | `/v1/admin/...` |

Roles of a person in a store, each including the previous:

| Role | May |
|---|---|
| `viewer` | Read reports and runs |
| `operator` | Also trigger runs and change report settings. The usual role for a client |
| `manager` | Also replace credentials and issue or revoke plugin tokens |

The platform admin role is separate: it creates stores and manages users. It does not by
itself give access to a store's data; that always comes from a membership.

Both use the same services underneath. The admin API is part of the core from the start,
because creating a store and issuing its token depend on it; the panel UI can come later
and, until then, the same routes are used from the command line.

## Flows

### Plugin request

1. The plugin sends its token in the `Authorization` header.
2. The hub hashes the token, finds it in `api_tokens`, and gets the `store_id` and scopes.
3. The request runs inside that store (see tenant isolation below).

The plugin never states which store it is. The token does.

### Scheduled collection (KuantoKusta)

1. A daily schedule, defined in Portugal time, walks `stores` and creates one `job_runs` row per store that has a
   KuantoKusta credential. Stores without one are skipped.
2. The job loads that store's key from `store_credentials`, syncs the store's offers from
   the Seller API, then reads the product page of each active offer.
3. Each page reading is saved as a `kk_page_snapshots` row; each offer gets a
   `kk_price_comparisons` row computed from it.

### Regenerate (manual)

1. The plugin (or panel) asks for a new run.
2. If a full run is already queued or running for the store, the hub returns that run
   instead of creating another. The database enforces this with a unique partial index.
3. Otherwise a run is created, subject to a minimum interval between manual runs.
4. The caller polls the run for progress ("40 of 185").

A single-offer refresh reads one page and may run in parallel with others.

Regenerating shows what competitors did. It does not show the effect of a price the store
just changed, because KuantoKusta only displays the new price after it re-imports the
store's catalogue.

## Tenant isolation

Tenant = store. Enforced in three places:

1. **Token to store.** The store comes from the authenticated principal, never from a
   request parameter.
2. **Row Level Security.** Every table with store data has `store_id NOT NULL` and a
   policy tied to a per-transaction setting (`app.current_store_id`). A query that forgets
   the store filter returns zero rows. In code, the setting is applied in one place only:
   `PrismaService.withStore(storeId, work)`. `tests/integration/tenant-isolation.int.spec.ts` proves the
   property against a real PostgreSQL, and fails when the policies are switched off.
3. **Composite foreign keys.** A comparison can only reference a run and an offer of its
   own store.

For the admin panel there is no "see everything" mode that switches the policy off. The
admin picks a store, the hub checks membership, and the query runs inside that store.

Shared tables without RLS, on purpose: `stores` and `api_tokens` (the token lookup happens
before the store is known), `kk_products` and `kk_page_snapshots` (public data, shared so
one page reading serves every store that sells the product).

## Data layers (KuantoKusta)

| Layer | Table | Lifetime |
|---|---|---|
| Raw | `kk_page_snapshots`: every store and price the page showed | 90 days |
| Computed | `kk_price_comparisons`: store price, lowest price, cheapest store, difference, position | Kept |

Keeping the raw layer allows recalculating when a rule changes without reading the site
again. Percentage and "easy adjust" are derived on read, so changing the threshold needs
no recalculation at all.

## Build order

Version 1 is the core and the `kuantokusta` module, for Zincomed. This is what the client
is waiting for.

Deferred (decision 0013): Farmácia Nova Porto as a second store, and the `fourdpharma`
module. The service is multi-store and modular from day one, so adding a store should be
a matter of registering it, and a new integration is a new module beside the existing one.
