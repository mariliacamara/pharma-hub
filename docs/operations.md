# Operations

How to deploy the service, run the operator commands, and find out what happened when
something goes wrong. Last updated 2026-10-08.

There are no metrics or alerts yet. What exists is the log (one JSON object per line in
production) and the database. Nobody is told when a collection fails: look at
`kk:runs`, or at the plugin, which shows the status of the latest one.

## Deploying on Railway

Done for the first time on 2026-10-08. The mistakes made that day are listed, because
they are the ones most likely to be made again.

### Once per environment

The step-by-step checklist, from the empty Railway project to the first price
collection, is in [`new-environment.md`](new-environment.md). In short: a PostgreSQL
database, the `pharma_hub_app` role (`db/roles.sql`), three variables (`DATABASE_URL`,
`DATABASE_MIGRATION_URL`, `CREDENTIALS_MASTER_KEY`), the pre-deploy command
`npx prisma migrate deploy` and the health check path `/health/ready`.

### What went wrong the first time

| Symptom in the deploy log | Cause | Fix |
|---|---|---|
| `Can't reach database server at {{Postgres.PGHOST}}` | The `${{Postgres.PGHOST}}` references typed into `DATABASE_URL` reached the service as plain text. Why they were not resolved was not established | Write the internal address out, as in the table above |
| `Operation has timed out`, after two minutes | `DATABASE_URL` pointed at the public address, which stopped answering when public networking was disabled | Use `postgres.railway.internal:5432` |
| Coloured log lines instead of JSON; `/docs` open to anyone | A `NODE_ENV` variable set to something other than `production` | Delete the variable. The image sets `production`, and so does the service when the variable is absent |
| `Refusing to start: the database role is a superuser` | `DATABASE_URL` is Railway's own connection | Use the `pharma_hub_app` connection |

Do not paste a connection string or a key into a chat or an issue. If one leaks,
regenerate the database password and redeploy. Railway's documentation places that
under the database's Config tab; it was not tried here.

### Limits of this setup

- The pre-deploy command runs with the service's variables, so the owner's connection
  (`DATABASE_MIGRATION_URL`) is present in the running service's environment. The
  service never reads it. Running migrations from CI instead would remove it.
- The health check is used by Railway during a deploy only. Nothing watches the service
  afterwards.

## Operator commands

They run inside the service's container (decision 0020). On Railway: the **Console**
tab of the service (used on 2026-10-08 for everything below up to `kk:sync-offers`).

```bash
node dist/cli.js                 # lists the commands
node dist/cli.js store:list
```

(`railway ssh`, from Railway's command line, is described in its documentation and was
not tried here.)

### Setting up a store

```bash
node dist/cli.js store:create --slug zincomed --name Zincomed --brand "ZincoGroup Hub"
node dist/cli.js kk:set-key --store zincomed        # asks for the key, hidden
node dist/cli.js kk:sync-offers --store zincomed
node dist/cli.js kk:status --store zincomed
node dist/cli.js token:issue --store zincomed --label "WordPress plugin"
```

- `kk:set-key` needs a terminal to ask for the key. Without one, pipe it in:
  `printf %s "$KEY" | node dist/cli.js kk:set-key --store zincomed`. Never put the key
  after the command as an argument.
- The token is shown once. If it is lost, revoke it (`token:revoke --prefix ...`) and
  issue another.
- A token issued this way has every scope and does not expire, which is what the plugin
  needs. For anything else, pass `--scopes prices:read` and `--expires-in-days`.

### Price collection

```bash
node dist/cli.js kk:collect --store zincomed     # queues one; the service carries it out
node dist/cli.js kk:runs --store zincomed        # the latest ones, and how the last ended
node dist/cli.js kk:status --store zincomed      # key, offers, how the store was recognised
node dist/cli.js kk:configure --store zincomed --kk-slug zincomed --easy-adjust-cents 10
```

- `kk:collect` only puts the collection in the queue. The running service picks it up
  within five seconds and reads one page every five seconds: a few hundred offers take
  about half an hour. The command returns at once.
- If one is already waiting or running, the command says so and queues nothing.
- After a collection ends there is a wait before the next (`kuantokusta.md`). The
  command says how long. `--ignore-wait` skips it; do not use it after a `blocked` run
  unless KuantoKusta said the hub may come back.
- `kk:configure --kk-slug` is only needed when a collection ends as
  `store_identity_unknown`. The slug is the store's name as it appears in the address of
  its page on KuantoKusta. `--easy-adjust-cents` sets the "easy adjust" threshold.
- The daily collection is off unless the variable `KK_COLLECTION_DAILY_AT` is set to a
  time such as `06:30` (Portugal time), which needs a redeploy. The log says which at
  start: `Daily collection at 06:30, Portugal time` or `Daily collection is off`.

### After changing the master key variables

```bash
node dist/cli.js kk:check-keys
```

It tries to decrypt every stored key, calls nobody, and shows nothing but
`readable` / `unreadable` per store. A wrong master key breaks nothing visible until the
next collection, so run this after any change to `CREDENTIALS_MASTER_KEY` or
`CREDENTIALS_PREVIOUS_KEYS`.

### Rotating the master key

1. Generate a new key and give it the next version: `2:<base64>`.
2. Move the old value to `CREDENTIALS_PREVIOUS_KEYS` (`1:<old base64>`), set the new one
   as `CREDENTIALS_MASTER_KEY`, deploy.
3. `kk:check-keys` must say `readable` for every store.
4. A stored key moves to the new version when it is set again (`kk:set-key`). There is
   no command yet that re-encrypts every key by itself, so the old version stays in
   `CREDENTIALS_PREVIOUS_KEYS` until every store has been set again.

## Reading the database by hand

**Connected as `pharma_hub_app`, the tables with store data look empty.** That is Row
Level Security doing its job, not data loss. Either choose a store first:

```sql
SELECT set_config('app.current_store_id', '<store uuid>', false);
```

or connect with the owner's connection (`DATABASE_MIGRATION_URL`), which sees
everything.

Useful queries (with the owner's connection):

```sql
-- When did each store last copy its offers, and what happened?
SELECT s.slug, a.occurred_at, a.details
  FROM audit_events a JOIN stores s ON s.id = a.store_id
 WHERE a.action = 'kk_offers.synced'
 ORDER BY a.occurred_at DESC LIMIT 20;

-- Offers that were not seen for two days but are still listed.
SELECT store_id, count(*) FROM kk_store_offers
 WHERE listing_status = 'listed' AND last_seen_at < now() - interval '2 days'
 GROUP BY 1;

-- Collections of every store, newest first.
SELECT s.slug, j.status, j.error_code, j.trigger, j.attempts,
       j.items_ok, j.items_failed, j.items_total,
       j.queued_at, j.started_at, j.heartbeat_at, j.finished_at
  FROM job_runs j JOIN stores s ON s.id = j.store_id
 ORDER BY j.queued_at DESC LIMIT 20;

-- What the last pages read looked like (shared by all stores).
SELECT outcome, http_status, count(*), max(fetched_at)
  FROM kk_page_snapshots WHERE fetched_at > now() - interval '1 day'
 GROUP BY 1, 2 ORDER BY 3 DESC;

-- Which master key version encrypted each stored key.
SELECT key_version, count(*) FROM store_credentials GROUP BY 1;

-- Everything done to a store, newest first.
SELECT occurred_at, actor_type, actor_label, action, target, details
  FROM audit_events WHERE store_id = '<store uuid>' ORDER BY id DESC LIMIT 50;
```

## Reading the log

| Line | Meaning |
|---|---|
| `GET /v1/plugin/... status=200 ms=... request=... store=... token=...` | One line per request. `token` is the prefix shown by `token:list`, never the token |
| `Refused a revoked token prefix=...` / `Refused an expired token prefix=...` | Why a plugin suddenly gets 401 |
| `GET /v2/kms/offers page=N status ... ms=... for=<store>` | Each call to KuantoKusta |
| `Offers sync finished store=... fetched=... delisted=... held_back=... skipped=...` | The result. At warning level when something was skipped or held back |
| `Offers sync failed store=... error=... reason="..."` | Why it failed |
| `Seller API at seller.kuantokusta.pt` | Which KuantoKusta the service talks to, said once at start |
| `Collection worker started` | Said once at start. Without it no collection is carried out |
| `Collection started store=... run=... attempt=N` | The worker took a collection. `attempt` above 1: it was taken up again |
| `GET /p/<id> ok status=200 ms=...` | Each page read, with its outcome |
| `Collection finished store=... status=... error=... total=... ok=... failed=...` | The result |
| `Collection put back in the queue store=... run=...` | The service was asked to stop in the middle of one. Normal on a redeploy |
| `Abandoned collections store=... failed=N requeued=N` | A collection was found without signs of life and taken up again, or given up |
| `Collection crashed store=... run=... attempt=N` | Something unexpected, with the cause. It is tried again in about three minutes |
| `Recognised the store on KuantoKusta store=... slug="..." seller=... matches=N/M` | How the store was found on the pages, the first time |
| `Could not tell which store is the hub's store=... reason=...` | See `store_identity_unknown` below |
| `robots.txt unavailable: ...` | Why the rules could not be read |
| `Database connection lost: ...` | A connection broke and the pool replaced it |
| `Unhandled error request=...` | A bug. The request id is the one the caller received |

## When the copy of the offers goes wrong

| What you see | Cause | What to do |
|---|---|---|
| `error=KkKeyRejectedError` | KuantoKusta refused the key. Usually it was changed in the KuantoKusta back office | `kk:set-key` with the new key |
| `error=KkCredentialMissingError` | The store has no key | `kk:set-key` |
| `error=CredentialDecryptionError` | The master key in this environment is not the one that encrypted the key | Restore the old master key into `CREDENTIALS_PREVIOUS_KEYS`; if it is lost, `kk:set-key` again |
| `error=KkRateLimitedError`, lines with `status 429` | Something else is using the same key at the same time | Wait a minute and run once. Do not run the command while another copy is running |
| `error=KkUnavailableError reason="... timeout"` or `status 5xx` | KuantoKusta is down or slow | Nothing was changed. Try later |
| `reason="... redirect refused"` or `status 404` | The API moved | Check `KK_SELLER_API_BASE_URL` |
| `reason="status 403 that did not come from the API"` | A firewall in front of KuantoKusta blocked the hub | Talk to KuantoKusta; the key is not the problem |
| `reason="... is not JSON"`, `"... not a list"`, `"none of the N items could be read"` | The answer changed shape | The code that reads it (`modules/kuantokusta/domain/seller-offer.ts`) needs updating. Nothing was stored |
| `held_back=too_many_at_once` | More than 10 offers, and more than 20% of the listed ones, were missing from the answer | Usually a faulty answer: the next run fixes it. If the store really removed them: `kk:sync-offers --store ... --allow-mass-delisting` |
| `held_back=items_skipped` | Some items could not be read, so nothing was delisted | Look at `skipped=`; the reasons are listed in `docs/kuantokusta.md` |

A failed copy changes nothing: either every page is read and written in one transaction,
or nothing is. Running it again is always safe.

## When a collection goes wrong

`kk:runs --store <slug>` shows the status and the code. The codes are explained in
`kuantokusta.md`, "How a collection ends".

| What you see | Cause | What to do |
|---|---|---|
| Stays `queued` | The service is not running, or it is busy with another store's collection | Look for `Collection worker started` in the log. One collection runs at a time for the whole hub |
| Stays `running`, pages not advancing | The worker died without saying so | Nothing: after three minutes without a sign of life it is taken up again by itself, and the pages already read are not read again |
| `failed (abandoned)` or `failed (internal_error)` | It was taken up three times and never finished | The log has `Collection crashed` with the cause. `kk:collect --ignore-wait` after fixing it |
| `blocked (blocked_by_site)` | The website refused three pages in a row | **Do not insist.** No store's collection goes to the website for 30 minutes, and a person cannot ask again for an hour. If it repeats, talk to KuantoKusta before anything else |
| `blocked (robots_refused)` | `robots.txt` was refused, or disallows product pages for the hub | The same. Open `https://www.kuantokusta.pt/robots.txt` in a browser and compare with `tests/fixtures/robots-kuantokusta.txt` |
| `failed (robots_unavailable)` | `robots.txt` could not be read, so nothing was | Try in an hour. The log line `robots.txt unavailable` says why |
| `failed (page_layout_changed)` | Ten pages in a row came without the list of offers | KuantoKusta changed its pages. `modules/kuantokusta/domain/page-offers.ts` needs updating, and `PARSER_VERSION` raised |
| `failed (site_unavailable)`, `failed (no_page_read)` | The website is failing or slow | Try in an hour |
| `failed (store_identity_unknown)` | The hub could not tell which store on the pages is its own: fewer than five readable pages, or no store has the hub's prices | `kk:configure --store <slug> --kk-slug <name in KuantoKusta addresses>`, then `kk:collect --ignore-wait`. The pages are not read again |
| `failed (kk_key_...)`, `failed (kk_unavailable)` | The copy of the offers failed | See the next section |
| `partial`, with a few pages not read | Some pages failed or no longer exist | Normal. Those offers show "no data" until the next collection |
| The comparison looks wrong for every product | The store was recognised as the wrong one | `kk:status` shows who it was taken for. Correct with `kk:configure` |

A collection never changes anything on KuantoKusta, and asking for one twice never
starts two. Running `kk:collect` again is always safe; whether it is polite to the
website is what the waits are for.

### Old readings are not deleted yet

Every page read adds a row to `kk_page_snapshots` (a few kilobytes). Nothing removes
them. At one collection a day for one store this is small, but it only grows. Until a
job does it, delete by hand from time to time, with the owner's connection:

```sql
DELETE FROM kk_page_snapshots WHERE fetched_at < now() - interval '90 days';
```

The comparisons computed from those readings are kept; they only lose the link to the
reading.
