# Operations

How to deploy the service, run the operator commands, and find out what happened when
something goes wrong. Last updated 2026-10-08.

There are no metrics or alerts yet. What exists is the log (one JSON object per line in
production) and the database.

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

They run inside the service's container (decision 0020):

```bash
railway ssh                                   # a shell in the running service
node dist/cli.js                              # lists the commands
railway ssh -- node dist/cli.js store:list    # or one command, without a shell
```

(`railway ssh` is described in Railway's documentation and was not tried here. The
dashboard also shows a Console tab on the service.)

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
